import { existsSync } from 'node:fs';
import {
  estimateClose,
  formatUnits,
  instrumentById,
  parseUnits,
  PapertradeApiError,
  priceToRaw,
  streamWallet,
  type PapertradeClient,
  type PapertradeTrader,
  type PreparedIntent,
  type TradingState,
  type WalletState,
  type WalletStreamStatus,
} from 'papertrade-sdk';
import type { Address } from 'viem';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './log.js';
import {
  applyCloseFailed,
  applyCloseSubmitted,
  applyLeaderClosed,
  applyOpen,
  applyOpenFailed,
  applySimulatedClose,
  diffLeader,
  planDue,
  planEvent,
  reconcile,
  rollDay,
  type Action,
  type CloseAction,
  type FollowerState,
  type LeaderEvent,
  type MarketContext,
  type OpenAction,
  type PositionRef,
} from './planner.js';
import type { PersistedState, RunMode, StateStore } from './state-store.js';

export interface EngineOptions {
  config: ResolvedConfig;
  mode: RunMode;
  client: PapertradeClient;
  trader: PapertradeTrader;
  store: StateStore;
  state: PersistedState;
  log: Logger;
  /** Dry-run only: pretend the account holds this much free balance (18-decimal USD) instead of reading it. */
  assumeBalanceRaw?: bigint;
  now?: () => number;
  /** Test seam: replaces the SSE wallet stream. */
  stream?: typeof streamWallet;
  /** Test seam: replaces the mark price lookup. */
  fetchMark?: (instrumentId: number, signal: AbortSignal) => Promise<bigint | undefined>;
  killSwitchExists?: (path: string) => boolean;
  /** Seconds between housekeeping ticks (timeouts, kill switch, status line). Default 15. */
  tickSeconds?: number;
}

export interface EngineStats {
  leaderOpens: number;
  leaderCloses: number;
  copiedOpens: number;
  copiedCloses: number;
  skipped: number;
  failed: number;
}

const TRADING_TTL_MS = 10_000;
const CLOSE_RETRY_MS = 15_000;

export class CopyEngine {
  readonly stats: EngineStats = { leaderOpens: 0, leaderCloses: 0, copiedOpens: 0, copiedCloses: 0, skipped: 0, failed: 0 };
  private readonly o: EngineOptions;
  private readonly p: PersistedState;
  private readonly stopController = new AbortController();
  private readonly stops: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();
  private trading: { at: number; value: TradingState } | null = null;
  private realPositions: PositionRef[] = [];
  private baseAvailableRaw = 0n;
  private followerSeen = false;
  private killNotified = false;
  private closeRetryAt = new Map<string, number>();
  private tick: ReturnType<typeof setInterval> | undefined;
  private lastStatusAt = 0;

  constructor(options: EngineOptions) {
    this.o = options;
    this.p = options.state;
    if (options.assumeBalanceRaw !== undefined && options.mode !== 'dry-run') throw new Error('assumeBalance is only available in dry-run mode.');
    this.baseAvailableRaw = options.assumeBalanceRaw ?? 0n;
    this.followerSeen = options.assumeBalanceRaw !== undefined;
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private get log() {
    return this.o.log;
  }

  /** Begin streaming the follower and every leader. Resolves once the streams are started, not when they end. */
  async start(): Promise<void> {
    const { config, mode } = this.o;
    this.log.info('start', {
      mode,
      account: config.account,
      leaders: config.leaders.map((l) => l.address),
      message: mode === 'live' ? 'LIVE: signed intents will be submitted to the relayer' : 'DRY RUN: nothing is signed for submission and nothing is sent',
    });
    this.p.follower = rollDay(this.p.follower, this.now());
    const stream = this.o.stream ?? streamWallet;
    const baseUrl = this.o.client.http.baseUrl;

    if (this.o.assumeBalanceRaw === undefined) {
      this.stops.push(
        stream({
          wallet: config.account,
          baseUrl,
          signal: this.stopController.signal,
          onState: (ws) => this.enqueue(() => this.onFollower(ws)),
          onStatus: (status, detail) => this.onStatus('follower', config.account, status, detail),
        }),
      );
    }
    for (const leader of config.leaders) {
      this.stops.push(
        stream({
          wallet: leader.address,
          baseUrl,
          signal: this.stopController.signal,
          onState: (ws, kind) => this.enqueue(() => this.onLeader(leader.address, ws, kind)),
          onStatus: (status, detail) => this.onStatus('leader', leader.address, status, detail),
        }),
      );
    }
    this.tick = setInterval(() => this.enqueue(() => this.onTick()), (this.o.tickSeconds ?? 15) * 1000);
  }

  /** Resolves when every queued update has been fully processed. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Stop streaming, finish in-flight work and write state. Mirrored positions are left open on purpose. */
  async stop(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    this.stopController.abort();
    for (const s of this.stops) s();
    await this.queue;
    this.persist();
    const open = Object.values(this.p.follower.mappings).filter((m) => m.status === 'open' || m.status === 'pending' || m.status === 'closing');
    this.log.info('shutdown', {
      ...this.stats,
      mirroredOpen: open.length,
      message: open.length
        ? `${open.length} mirrored position(s) stay open. Restart to keep mirroring them, or close them yourself on papertrade.xyz.`
        : 'no mirrored positions are open',
    });
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(job).catch((err) => {
      this.log.error('internal_error', { message: err instanceof Error ? err.message : String(err) });
    });
  }

  private onStatus(role: 'leader' | 'follower', wallet: Address, status: WalletStreamStatus, detail?: string) {
    const level = status === 'reconnecting' ? 'warn' : 'info';
    this.log[level]('stream', { role, wallet, status, detail });
  }

  private persist() {
    this.p.updatedAtMs = this.now();
    this.o.store.save(this.p);
  }

  private async tradingState(): Promise<TradingState> {
    const now = this.now();
    if (this.trading && now - this.trading.at < TRADING_TTL_MS) return this.trading.value;
    const value = await this.o.client.tradingState(this.stopController.signal);
    this.trading = { at: now, value };
    return value;
  }

  private async markPrice(instrumentId: number, trading: TradingState): Promise<bigint | undefined> {
    if (this.o.fetchMark) return this.o.fetchMark(instrumentId, this.stopController.signal);
    const inst = trading.instruments.find((i) => i.id === instrumentId);
    if (!inst) return undefined;
    const { points } = await this.o.client.priceHistory({ instrumentId, lookbackMs: 20_000 }, this.stopController.signal);
    const last = points[points.length - 1];
    return last ? priceToRaw(last.price, inst.priceScale) : undefined;
  }

  private killSwitch(): boolean {
    return (this.o.killSwitchExists ?? existsSync)(this.o.config.guardrails.killSwitchFile);
  }

  /** The planner's view of the follower: real positions plus simulated ones, free balance net of simulated margin. */
  private view(): FollowerState {
    const sim = this.p.sim;
    const simMargin = sim.reduce((sum, s) => sum + s.marginRaw, 0n);
    const available = this.baseAvailableRaw - simMargin;
    return {
      ...this.p.follower,
      availableRaw: available > 0n ? available : 0n,
      positions: [...this.realPositions, ...sim.map((s) => ({ positionId: s.positionId, instrumentId: s.instrumentId, marginRaw: s.marginRaw }))],
    };
  }

  private adopt(next: FollowerState) {
    this.p.follower = { ...next, positions: [], availableRaw: 0n };
  }

  private async market(marksFor: number[] = []): Promise<MarketContext> {
    const trading = await this.tradingState();
    const marksRaw: Record<number, bigint> = {};
    for (const id of marksFor) {
      const mark = await this.markPrice(id, trading).catch((err: unknown) => {
        this.log.warn('mark_unavailable', { instrumentId: id, message: err instanceof Error ? err.message : String(err) });
        return undefined;
      });
      if (mark !== undefined) marksRaw[id] = mark;
    }
    return { nowMs: this.now(), trading, marksRaw, killSwitch: this.killSwitch() };
  }

  // Follower account updates

  private async onFollower(ws: WalletState) {
    this.followerSeen = true;
    this.baseAvailableRaw = ws.funds.availableBalance;
    this.realPositions = ws.positions.map((p) => ({ positionId: p.positionId.toString(), instrumentId: p.instrumentId, marginRaw: p.marginRaw }));
    const { state, notes } = reconcile(
      this.view(),
      {
        positions: ws.positions,
        operations: ws.operations,
        intentOutcomes: ws.intentOutcomes,
        closed: ws.closedPositions.map((c) => ({ positionId: c.positionId, netPnlRaw: c.netPnlRaw })),
      },
      this.now(),
    );
    this.adopt(state);
    for (const c of ws.closedPositions) {
      this.log.info('follower_closed', { positionId: c.positionId.toString(), liquidated: c.liquidated, netPnlUsd: formatUnits(c.netPnlRaw, 18), realizedTodayUsd: formatUnits(this.p.follower.realizedTodayRaw, 18) });
    }
    for (const n of notes) this.log[n.event === 'open_failed' || n.event === 'close_failed' ? 'warn' : 'info']('reconcile', { key: n.key, event: n.event, detail: n.detail });
    this.persist();
    await this.runDue();
  }

  private async onTick() {
    const { state, notes } = reconcile(this.view(), { positions: [], operations: [], intentOutcomes: [], closed: [] }, this.now());
    if (this.followerSeen) {
      // A tick has no wallet update to prove a position is gone, so only timeouts are applied here.
      const keep = this.p.follower;
      const timedOut = Object.fromEntries(Object.entries(state.mappings).filter(([k, m]) => keep.mappings[k]?.status !== m.status && (m.status === 'failed' || (keep.mappings[k]?.status === 'closing' && m.status === 'open'))));
      if (Object.keys(timedOut).length) {
        this.adopt({ ...keep, mappings: { ...keep.mappings, ...timedOut } });
        for (const n of notes.filter((x) => timedOut[x.key])) this.log.warn('reconcile', { key: n.key, event: n.event, detail: n.detail });
        this.persist();
      }
    }
    const killed = this.killSwitch();
    if (killed && !this.killNotified) {
      this.log.warn('kill_switch', { file: this.o.config.guardrails.killSwitchFile, message: `kill switch engaged: no new copies${this.o.config.flattenOnKill ? '; closing every mirrored position' : '; closes of mirrored positions continue'}` });
    }
    if (!killed && this.killNotified) this.log.info('kill_switch', { message: 'kill switch file removed: copying resumes' });
    this.killNotified = killed;
    await this.runDue();
    if (this.now() - this.lastStatusAt >= 60_000) {
      this.lastStatusAt = this.now();
      const mappings = Object.values(this.p.follower.mappings);
      this.log.info('status', {
        mirroredOpen: mappings.filter((m) => m.status === 'open').length,
        pending: mappings.filter((m) => m.status === 'pending').length,
        realizedTodayUsd: formatUnits(this.p.follower.realizedTodayRaw, 18),
        availableUsd: formatUnits(this.view().availableRaw, 18),
        ...this.stats,
      });
    }
  }

  private async runDue() {
    const market = await this.market();
    const due = planDue(this.view(), this.o.config, market).filter((a) => a.kind === 'close') as CloseAction[];
    const now = this.now();
    for (const action of due) {
      if ((this.closeRetryAt.get(action.key) ?? 0) > now) continue;
      this.closeRetryAt.set(action.key, now + CLOSE_RETRY_MS);
      await this.execute(action, market);
    }
  }

  // Leader updates

  private async onLeader(leader: Address, ws: WalletState, kind: 'snapshot' | 'update') {
    if (!this.followerSeen) {
      this.log.debug('leader_waiting', { leader, message: 'waiting for the follower account snapshot' });
      await this.waitForFollower();
    }
    const entry = this.p.leaders[leader];
    const diff = diffLeader(leader, entry?.known ?? null, ws.positions);
    if (kind === 'snapshot' || diff.events.length) {
      this.log.info('leader_state', { leader, kind, positions: ws.positions.length, opened: diff.events.filter((e) => e.type === 'open').length, closed: diff.events.filter((e) => e.type === 'close').length, baseline: entry?.known == null });
    }
    this.p.leaders[leader] = { known: diff.known, lastSeenAtMs: this.now() };
    const closedInfo = new Map(ws.closedPositions.map((c) => [c.positionId.toString(), c]));
    for (const event of diff.events) {
      if (event.type === 'open') {
        this.stats.leaderOpens += event.baseline ? 0 : 1;
        if (!event.baseline) {
          const p = event.position;
          this.log.info('leader_open', { leader, positionId: p.positionId.toString(), market: instrumentName(p.instrumentId), side: p.isLong ? 'long' : 'short', leverage: p.leverage, marginUsd: formatUnits(p.marginRaw, 18), entryPriceRaw: p.entryPriceRaw.toString() });
        }
      } else {
        this.stats.leaderCloses += 1;
        const c = closedInfo.get(event.positionId);
        this.log.info('leader_close', { leader, positionId: event.positionId, liquidated: c?.liquidated, netPnlUsd: c ? formatUnits(c.netPnlRaw, 18) : undefined });
      }
      await this.handle(event);
    }
    this.persist();
  }

  private async waitForFollower() {
    const deadline = Date.now() + 30_000;
    while (!this.followerSeen && Date.now() < deadline && !this.stopController.signal.aborted) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async handle(event: LeaderEvent) {
    const marksFor = event.type === 'open' ? [event.position.instrumentId] : [];
    const market = await this.market(marksFor);
    const actions = planEvent(event, this.view(), this.o.config, market);
    for (const action of actions) await this.execute(action, market);
  }

  // Execution

  private async execute(action: Action, market: MarketContext) {
    switch (action.kind) {
      case 'skip': {
        this.stats.skipped += action.code === 'no_mirrored_position' || action.code === 'preexisting_position' ? 0 : 1;
        const level = action.code === 'no_mirrored_position' || action.code === 'preexisting_position' || action.code === 'already_mirrored' ? 'debug' : 'info';
        this.log[level]('skip', { on: action.on, code: action.code, leader: action.leader, leaderPositionId: action.leaderPositionId, message: action.message });
        return;
      }
      case 'defer_close':
        this.adopt(applyLeaderClosed(this.view(), action.key, this.now()));
        this.log.info('defer_close', { leader: action.leader, leaderPositionId: action.leaderPositionId, message: action.message });
        return;
      case 'open':
        await this.executeOpen(action, market);
        return;
      case 'close':
        await this.executeClose(action, market);
        return;
    }
  }

  private describeOpen(a: OpenAction) {
    return {
      leader: a.leader,
      leaderPositionId: a.leaderPositionId,
      market: a.market,
      side: a.isLong ? 'long' : 'short',
      marginUsd: formatUnits(a.marginRaw, 18),
      leverage: a.leverage,
      notionalUsd: formatUnits(a.notionalRaw, 18),
      leaderMarginUsd: formatUnits(a.leaderMarginRaw, 18),
      leaderLeverage: a.leaderLeverage,
      slippagePct: (Number(a.slippagePpm) / 10_000).toFixed(4),
      adjustments: a.adjustments.length ? a.adjustments : undefined,
    };
  }

  private describeIntent(prepared: PreparedIntent, extra: Record<string, unknown> = {}) {
    const { v: _v, r: _r, s: _s, ...message } = prepared.signed;
    return {
      action: prepared.action,
      primaryType: prepared.primaryType,
      domain: prepared.domain,
      message,
      intentId: prepared.intentId,
      signedBy: prepared.signer,
      summary: prepared.summary,
      ...extra,
    };
  }

  private async executeOpen(a: OpenAction, market: MarketContext) {
    const now = this.now();
    const params = { market: a.instrumentId, side: a.isLong ? ('long' as const) : ('short' as const), marginUsd: formatUnits(a.marginRaw, 18), leverage: a.leverage };
    let prepared: PreparedIntent;
    try {
      prepared = await this.o.trader.prepareOpen(params, market.trading);
    } catch (err) {
      this.stats.failed += 1;
      this.log.warn('open_rejected_locally', { ...this.describeOpen(a), message: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (this.o.mode === 'dry-run') {
      const simId = `sim-${++this.p.simSeq}`;
      this.log.info('would_sign', { ...this.describeOpen(a), intent: this.describeIntent(prepared, { dryRun: 'signed locally with a throwaway key; never submitted' }) });
      this.p.sim.push({ positionId: simId, instrumentId: a.instrumentId, isLong: a.isLong, marginRaw: a.marginRaw, leverage: a.leverage, entryPriceRaw: a.markPriceRaw });
      this.adopt(applyOpen(this.view(), a, prepared.intentId, now, simId));
      this.stats.copiedOpens += 1;
      this.log.info('simulated_open', { ...this.describeOpen(a), followerPositionId: simId, entryPriceRaw: a.markPriceRaw.toString() });
      this.persist();
      return;
    }

    this.adopt(applyOpen(this.view(), a, prepared.intentId, now));
    this.persist();
    this.log.info('sign_open', { ...this.describeOpen(a), intentId: prepared.intentId });
    try {
      const submitted = await this.o.trader.submit(prepared, this.stopController.signal);
      this.stats.copiedOpens += 1;
      this.log.info('submitted_open', { ...this.describeOpen(a), intentId: prepared.intentId, state: submitted.receipt.state });
    } catch (err) {
      const definitive = err instanceof PapertradeApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
      const message = err instanceof Error ? err.message : String(err);
      if (definitive || (err instanceof Error && err.name === 'PapertradeIntentError')) {
        this.stats.failed += 1;
        this.adopt(applyOpenFailed(this.view(), a.key, message, this.now()));
        this.log.error('open_rejected', { ...this.describeOpen(a), intentId: prepared.intentId, code: err instanceof PapertradeApiError ? err.code : undefined, reason: err instanceof PapertradeApiError ? err.reason : undefined, message });
      } else {
        this.log.warn('open_unconfirmed', { ...this.describeOpen(a), intentId: prepared.intentId, message: `${message}. The intent may still land; watching the account for it.` });
      }
    }
    this.persist();
  }

  private async executeClose(a: CloseAction, market: MarketContext) {
    const now = this.now();
    const mapping = this.p.follower.mappings[a.key];
    if (!mapping) return;
    this.adopt(applyLeaderClosed(this.view(), a.key, now));
    const ids = a.followerPositionIds;
    const detail = { leader: a.leader, leaderPositionId: a.leaderPositionId, followerPositionIds: ids, reason: a.reason, market: instrumentName(mapping.instrumentId) };

    if (this.o.mode === 'dry-run') {
      const sim = this.p.sim.find((s) => s.positionId === ids[0]);
      const prepared = await this.o.trader.prepareClose(ids.map((id) => (id.startsWith('sim-') ? 1n : BigInt(id))));
      this.log.info('would_sign', { ...detail, intent: this.describeIntent(prepared[0], { dryRun: 'signed locally with a throwaway key; never submitted', note: 'position id is a placeholder: the simulated position does not exist on chain' }) });
      let pnl = 0n;
      if (sim) {
        const mark = await this.markPrice(sim.instrumentId, market.trading).catch(() => undefined);
        if (mark !== undefined) {
          const inst = market.trading.instruments.find((i) => i.id === sim.instrumentId);
          if (inst) {
            const est = estimateClose({ instrument: inst, isLong: sim.isLong, entryPriceRaw: sim.entryPriceRaw, exitPriceRaw: mark, marginRaw: sim.marginRaw, leverage: sim.leverage });
            pnl = parseUnits(est.netPnlUsd.toFixed(6), 18);
            this.log.info('simulated_close', { ...detail, entryPriceRaw: sim.entryPriceRaw.toString(), exitPriceRaw: mark.toString(), estimatedNetPnlUsd: est.netPnlUsd.toFixed(2), liquidated: est.liquidated });
          }
        }
        this.p.sim = this.p.sim.filter((s) => s.positionId !== sim.positionId);
      }
      this.adopt(applySimulatedClose(this.view(), a.key, pnl, now));
      this.stats.copiedCloses += 1;
      this.persist();
      return;
    }

    let prepared: PreparedIntent[];
    try {
      prepared = await this.o.trader.prepareClose(ids);
    } catch (err) {
      this.log.warn('close_rejected_locally', { ...detail, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.adopt(applyCloseSubmitted(this.view(), a.key, prepared[0].intentId, now));
    this.persist();
    for (const p of prepared) {
      this.log.info('sign_close', { ...detail, intentId: p.intentId });
      try {
        const submitted = await this.o.trader.submit(p, this.stopController.signal);
        this.stats.copiedCloses += 1;
        this.log.info('submitted_close', { ...detail, intentId: p.intentId, state: submitted.receipt.state });
      } catch (err) {
        this.stats.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.adopt(applyCloseFailed(this.view(), a.key, message, this.now()));
        this.log.error('close_rejected', { ...detail, intentId: p.intentId, code: err instanceof PapertradeApiError ? err.code : undefined, reason: err instanceof PapertradeApiError ? err.reason : undefined, message: `${message}. Will retry.` });
      }
    }
    this.persist();
  }
}

function instrumentName(id: number): string {
  try {
    return instrumentById(id).name;
  } catch {
    return `instrument-${id}`;
  }
}
