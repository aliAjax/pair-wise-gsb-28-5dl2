import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ACTIVE_RETURN_STATUSES,
  Conflict,
  DRIVERS,
  OCCUPYING_RETURN_STATUSES,
  Order,
  Receipt,
  ReturnOrder,
  Revision,
  RevisionType,
  RULES,
  SLOTS,
  State,
  STATUS_CLASS,
  VEHICLES,
  activeReturnForOrder,
  driverTasks,
  fmtTime,
  latestReturnForOrder,
  nextReceiptNo,
  nextReturnNo,
  nextSeq,
  nowIso,
  shortSlot,
  uid,
} from "./domain";
import { buildSeed } from "./seed";

const project = {
  number: 14,
  folder: "hxwl/frontend/hxwlfront-14",
  title: "配送任务拖拽排班",
  subtitle: "正向排班 + 逆向回仓闭环：拒收生成回仓单，回仓完成释放司机并留下修订链，原签收单不改写。",
  industry: "物流",
  stack: ["React", "Vite", "TypeScript", "Ant Design", "dnd-kit"],
  storageKey: "hxwlfront-14-reverse-v1",
  formTitle: "新增待分配订单",
  primaryAction: "加入待分配",
  entityLabel: "订单",
  metricLabels: ["订单数", "签收单", "回仓中", "总重量kg"],
} as const;

type Banner = { text: string; kind: "ok" | "warn" };
type Modal =
  | { kind: "reject"; order: Order }
  | { kind: "weight"; ret: ReturnOrder }
  | { kind: "review"; ret: ReturnOrder };
type TabKey = "orders" | "returns" | "docs" | "conflicts";

function loadState(): State {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) return buildSeed();
  try {
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!Array.isArray(parsed.orders) || !Array.isArray(parsed.returns)) return buildSeed();
    return { receipts: [], revisions: [], conflicts: [], ...parsed } as State;
  } catch {
    return buildSeed();
  }
}

function saveState(state: State) {
  localStorage.setItem(project.storageKey, JSON.stringify(state));
}

function blankForm() {
  return { orderNo: "", destination: "", weight: 0, driver: "", vehicle: "", slot: "" };
}

export default function App() {
  const [state, setState] = useState<State>(loadState);
  const [form, setForm] = useState(blankForm);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("全部司机");
  const [tab, setTab] = useState<TabKey>("orders");
  const [modal, setModal] = useState<Modal | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(timer);
  }, [banner]);

  function commit(next: State) {
    setState(next);
    saveState(next);
  }

  function pushConflict(base: State, c: Omit<Conflict, "id" | "createdAt">): State {
    return { ...base, conflicts: [{ ...c, id: uid(), createdAt: nowIso() }, ...base.conflicts] };
  }

  function makeRevision(
    base: State,
    orderId: string,
    orderNo: string,
    seqOffset: number,
    type: RevisionType,
    reason: string,
    detail: string
  ): Revision {
    return {
      id: uid(),
      orderId,
      orderNo,
      seq: nextSeq(base.revisions, orderId) + seqOffset,
      type,
      reason,
      detail,
      createdAt: nowIso(),
    };
  }

  // ---------- 正向排班 ----------

  function handleCreateOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const order: Order = {
      id: uid(),
      orderNo: form.orderNo.trim(),
      destination: form.destination.trim(),
      weight: Number(form.weight),
      driver: form.driver,
      vehicle: form.vehicle,
      slot: form.slot,
      status: "待分配",
      notes: note.trim() || "暂无备注",
      createdAt: nowIso(),
    };
    commit({ ...state, orders: [order, ...state.orders] });
    setForm(blankForm());
    setNote("");
    setBanner({ kind: "ok", text: `订单 ${order.orderNo} 已加入待分配` });
  }

  function handleSchedule(order: Order) {
    const tasks = driverTasks(state, order.driver, order.slot);
    if (tasks.length > 0) {
      const detail = `${order.driver} 在 ${order.slot} 已有任务：${tasks.map((t) => `${t.kind} ${t.ref}`).join("、")}；订单 ${order.orderNo} 排班被拒绝`;
      commit(pushConflict(state, { orderNo: order.orderNo, driver: order.driver, slot: order.slot, rule: RULES.DRIVER_BUSY, detail }));
      setBanner({ kind: "warn", text: detail });
      return;
    }
    commit({ ...state, orders: state.orders.map((o) => (o.id === order.id ? { ...o, status: "已分配" } : o)) });
    setBanner({ kind: "ok", text: `订单 ${order.orderNo} 已排班：${order.driver} ${order.slot}` });
  }

  function handleSign(order: Order) {
    const receipt: Receipt = {
      id: uid(),
      receiptNo: nextReceiptNo(state.receipts),
      orderId: order.id,
      orderNo: order.orderNo,
      driver: order.driver,
      vehicle: order.vehicle,
      slot: order.slot,
      weight: order.weight,
      destination: order.destination,
      signedAt: nowIso(),
    };
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? { ...o, status: "已签收" } : o)),
      receipts: [receipt, ...state.receipts],
    });
    setBanner({ kind: "ok", text: `订单 ${order.orderNo} 已签收，签收单 ${receipt.receiptNo} 已生成（原始凭证，不可改写）` });
  }

  function handleDeleteOrder(order: Order) {
    commit({ ...state, orders: state.orders.filter((o) => o.id !== order.id) });
    setBanner({ kind: "ok", text: `订单 ${order.orderNo} 已删除` });
  }

  // ---------- 逆向回仓闭环 ----------

  function handleAttemptCreateReturn(order: Order) {
    const existing = activeReturnForOrder(state.returns, order.id);
    if (existing) {
      const detail = `订单 ${order.orderNo} 已存在有效回仓单 ${existing.returnNo}（${existing.status}），新建回仓单被拒绝`;
      commit(pushConflict(state, { orderNo: order.orderNo, driver: existing.driver, slot: existing.slot, rule: RULES.DUP_RETURN, detail }));
      setBanner({ kind: "warn", text: detail });
      return;
    }
    setModal({ kind: "reject", order });
  }

  function handleRejectSubmit(order: Order, v: { reason: string; slot: string; driver: string; vehicle: string }) {
    setModal(null);
    const existing = activeReturnForOrder(state.returns, order.id);
    if (existing) {
      const detail = `订单 ${order.orderNo} 已存在有效回仓单 ${existing.returnNo}（${existing.status}），新建回仓单被拒绝`;
      commit(pushConflict(state, { orderNo: order.orderNo, driver: v.driver, slot: v.slot, rule: RULES.DUP_RETURN, detail }));
      setBanner({ kind: "warn", text: detail });
      return;
    }
    const returnNo = nextReturnNo(state.returns);
    const ret: ReturnOrder = {
      id: uid(),
      returnNo,
      orderId: order.id,
      orderNo: order.orderNo,
      slot: v.slot,
      driver: v.driver,
      vehicle: v.vehicle,
      reason: v.reason,
      status: "待接单",
      expectedWeight: order.weight,
      actualWeight: null,
      reviewNote: null,
      createdAt: nowIso(),
      completedAt: null,
    };
    const hadReceipt = state.receipts.some((r) => r.orderId === order.id);
    const revision = makeRevision(
      state,
      order.id,
      order.orderNo,
      0,
      "拒收",
      v.reason,
      `生成回仓单 ${returnNo}，取件时段 ${v.slot}，司机 ${v.driver}，车辆 ${v.vehicle}${hadReceipt ? "；原签收单保留不改写" : ""}`
    );
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? { ...o, status: "拒收" } : o)),
      returns: [ret, ...state.returns],
      revisions: [...state.revisions, revision],
    });
    setTab("returns");
    setBanner({ kind: "ok", text: `订单 ${order.orderNo} 已拒收，回仓单 ${returnNo} 已生成（待接单）` });
  }

  function handleAccept(ret: ReturnOrder) {
    const tasks = driverTasks(state, ret.driver, ret.slot);
    if (tasks.length > 0) {
      const detail = `${ret.driver} 在 ${ret.slot} 已有任务：${tasks.map((t) => `${t.kind} ${t.ref}`).join("、")}；回仓单 ${ret.returnNo} 接单被拒绝`;
      commit(pushConflict(state, { orderNo: ret.orderNo, driver: ret.driver, slot: ret.slot, rule: RULES.DRIVER_BUSY, detail }));
      setBanner({ kind: "warn", text: detail });
      return;
    }
    commit({ ...state, returns: state.returns.map((r) => (r.id === ret.id ? { ...r, status: "待取件" } : r)) });
    setBanner({ kind: "ok", text: `回仓单 ${ret.returnNo} 已接单，${ret.driver} 的 ${ret.slot} 时段被占用` });
  }

  function handleWeightSubmit(ret: ReturnOrder, actualWeight: number) {
    setModal(null);
    if (actualWeight === ret.expectedWeight) {
      const revision = makeRevision(
        state,
        ret.orderId,
        ret.orderNo,
        0,
        "回仓完成",
        ret.reason,
        `回仓单 ${ret.returnNo} 已回仓，回仓重量 ${actualWeight}kg 与原单一致；司机 ${ret.driver} 已释放`
      );
      commit({
        ...state,
        orders: state.orders.map((o) => (o.id === ret.orderId ? { ...o, status: "已回仓" } : o)),
        returns: state.returns.map((r) => (r.id === ret.id ? { ...r, status: "已回仓", actualWeight, completedAt: nowIso() } : r)),
        revisions: [...state.revisions, revision],
      });
      setBanner({ kind: "ok", text: `回仓单 ${ret.returnNo} 已回仓，司机 ${ret.driver} 已释放` });
      return;
    }
    const detail = `回仓重量 ${actualWeight}kg 与原单 ${ret.expectedWeight}kg 不一致，回仓单 ${ret.returnNo} 转入待复核`;
    commit(
      pushConflict(
        { ...state, returns: state.returns.map((r) => (r.id === ret.id ? { ...r, status: "待复核", actualWeight } : r)) },
        { orderNo: ret.orderNo, driver: ret.driver, slot: ret.slot, rule: RULES.WEIGHT_REVIEW, detail }
      )
    );
    setBanner({ kind: "warn", text: `${detail}（规则 R3）` });
  }

  function handleReviewSubmit(ret: ReturnOrder, reviewNote: string) {
    setModal(null);
    const actual = ret.actualWeight ?? ret.expectedWeight;
    const diff = actual - ret.expectedWeight;
    const revReview = makeRevision(
      state,
      ret.orderId,
      ret.orderNo,
      0,
      "重量复核",
      "回仓重量与原单不一致",
      `原单 ${ret.expectedWeight}kg，回仓 ${actual}kg，差异 ${diff}kg；${reviewNote}`
    );
    const revDone = makeRevision(
      state,
      ret.orderId,
      ret.orderNo,
      1,
      "回仓完成",
      ret.reason,
      `回仓单 ${ret.returnNo} 已回仓，回仓重量 ${actual}kg（已复核）；司机 ${ret.driver} 已释放`
    );
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === ret.orderId ? { ...o, status: "已回仓" } : o)),
      returns: state.returns.map((r) => (r.id === ret.id ? { ...r, status: "已回仓", reviewNote, completedAt: nowIso() } : r)),
      revisions: [...state.revisions, revReview, revDone],
    });
    setBanner({ kind: "ok", text: `回仓单 ${ret.returnNo} 复核通过并已回仓，司机 ${ret.driver} 已释放` });
  }

  function handleCancelReturn(ret: ReturnOrder) {
    const occupying = OCCUPYING_RETURN_STATUSES.includes(ret.status);
    commit({ ...state, returns: state.returns.map((r) => (r.id === ret.id ? { ...r, status: "已取消" } : r)) });
    setBanner({ kind: "ok", text: `回仓单 ${ret.returnNo} 已取消${occupying ? `，${ret.driver} 的 ${ret.slot} 时段已释放` : ""}` });
  }

  // ---------- 派生数据 ----------

  const activeReturnCount = useMemo(
    () => state.returns.filter((r) => ACTIVE_RETURN_STATUSES.includes(r.status)).length,
    [state.returns]
  );

  const metrics = useMemo(() => {
    const totalWeight = state.orders.reduce((acc, o) => acc + Number(o.weight || 0), 0);
    return [state.orders.length, state.receipts.length, activeReturnCount, totalWeight];
  }, [state, activeReturnCount]);

  const filteredOrders = useMemo(() => {
    if (filter === "全部司机") return state.orders;
    return state.orders.filter((o) => o.driver === filter);
  }, [state.orders, filter]);

  const revisionGroups = useMemo(() => {
    const groups = new Map<string, Revision[]>();
    for (const rev of state.revisions) {
      groups.set(rev.orderNo, [...(groups.get(rev.orderNo) ?? []), rev]);
    }
    return [...groups.entries()]
      .map(([orderNo, items]) => ({
        orderNo,
        items: [...items].sort((a, b) => a.seq - b.seq),
        latest: Math.max(...items.map((i) => Date.parse(i.createdAt))),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [state.revisions]);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "orders", label: `订单排班 (${state.orders.length})` },
    { key: "returns", label: `回仓单 (${activeReturnCount})` },
    { key: "docs", label: `签收单·修订链 (${state.receipts.length}/${state.revisions.length})` },
    { key: "conflicts", label: `冲突记录 (${state.conflicts.length})` },
  ];

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">{project.industry}行业前端最小闭环</p>
            <h1>{project.title}</h1>
            <p className="subtitle">{project.subtitle}</p>
          </div>
          <div className="stack">{project.stack.map((item) => <span className="tag" key={item}>{item}</span>)}</div>
        </header>

        {banner && (
          <div className={`banner ${banner.kind}`}>
            <span>{banner.text}</span>
            <button type="button" onClick={() => setBanner(null)}>×</button>
          </div>
        )}

        <section className="metrics">
          {project.metricLabels.map((label, index) => (
            <article className="metric" key={label}>
              <span>{label}</span>
              <strong>{metrics[index]}</strong>
            </article>
          ))}
        </section>

        <section className="workspace">
          <form className="panel" onSubmit={handleCreateOrder}>
            <h2>{project.formTitle}</h2>
            <div className="form-grid">
              <label>
                订单号
                <input value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} placeholder="例如 ORD-9050" required />
              </label>
              <label>
                目的地
                <input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="例如 浦东" required />
              </label>
              <label>
                重量kg
                <input type="number" min={1} value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} required />
              </label>
              <label>
                司机
                <select value={form.driver} onChange={(e) => setForm({ ...form, driver: e.target.value })} required>
                  <option value="">请选择</option>
                  {DRIVERS.map((d) => <option key={d}>{d}</option>)}
                </select>
              </label>
              <label>
                车辆
                <select value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} required>
                  <option value="">请选择</option>
                  {VEHICLES.map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label>
                配送时段
                <select value={form.slot} onChange={(e) => setForm({ ...form, slot: e.target.value })} required>
                  <option value="">请选择</option>
                  {SLOTS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
              <label>
                备注
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="填写处理说明或现场备注" />
              </label>
              <button type="submit">{project.primaryAction}</button>
            </div>
          </form>

          <section className="list-panel">
            <div className="tabs">
              {tabs.map((t) => (
                <button key={t.key} type="button" className={`tab-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "orders" && (
              <>
                <div className="toolbar">
                  <h2>{project.entityLabel}列表</h2>
                  <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option>全部司机</option>
                    {DRIVERS.map((d) => <option key={d}>{d}</option>)}
                  </select>
                </div>

                <div className="board-wrap">
                  <p className="muted">司机时段看板：已分配配送与已接单回仓会占用时段，回仓完成或取消后自动释放。</p>
                  <div className="board">
                    <div className="board-row board-head">
                      <span />
                      {SLOTS.map((s) => <span className="board-slot" key={s}>{shortSlot(s)}</span>)}
                    </div>
                    {DRIVERS.map((driver) => (
                      <div className="board-row" key={driver}>
                        <span className="board-driver">{driver}</span>
                        {SLOTS.map((slot) => {
                          const tasks = driverTasks(state, driver, slot);
                          return (
                            <div className="board-cell" key={slot}>
                              {tasks.length === 0 ? (
                                <span className="board-free">空闲</span>
                              ) : (
                                tasks.map((t) => (
                                  <span key={t.id} className={`chip ${t.kind === "配送" ? "delivery" : "pickup"}`}>
                                    {t.kind} {t.ref}
                                  </span>
                                ))
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="record-grid">
                  {filteredOrders.length === 0 ? <div className="empty">暂无匹配数据</div> : filteredOrders.map((order) => {
                    const ret = latestReturnForOrder(state.returns, order.id);
                    return (
                      <article className="record" key={order.id}>
                        <div className="record-head">
                          <p className="record-title">{order.orderNo} / {order.driver}</p>
                          <span className={`status ${STATUS_CLASS[order.status]}`}>{order.status}</span>
                        </div>
                        <div className="details">
                          <span>目的地: {order.destination}</span>
                          <span>重量: {order.weight}kg</span>
                          <span>车辆: {order.vehicle}</span>
                          <span>配送时段: {order.slot}</span>
                        </div>
                        <p className="note">{order.notes}</p>
                        {ret && (
                          <p className="linked">
                            回仓单 {ret.returnNo} · {ret.status}
                            {ret.actualWeight != null ? ` · 回仓 ${ret.actualWeight}kg` : ""}
                          </p>
                        )}
                        <div className="actions">
                          {order.status === "待分配" && (
                            <>
                              <button type="button" onClick={() => handleSchedule(order)}>确认排班</button>
                              <button className="danger" type="button" onClick={() => handleDeleteOrder(order)}>删除</button>
                            </>
                          )}
                          {order.status === "已分配" && (
                            <>
                              <button type="button" onClick={() => handleSign(order)}>签收</button>
                              <button className="secondary" type="button" onClick={() => setModal({ kind: "reject", order })}>拒收</button>
                            </>
                          )}
                          {order.status === "已签收" && (
                            <button className="secondary" type="button" onClick={() => setModal({ kind: "reject", order })}>拒收/退货</button>
                          )}
                          {order.status === "拒收" && (
                            <button type="button" onClick={() => handleAttemptCreateReturn(order)}>生成回仓单</button>
                          )}
                          {order.status === "已回仓" && <span className="muted">闭环完成，详见签收单·修订链</span>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            )}

            {tab === "returns" && (
              <>
                <div className="toolbar">
                  <h2>回仓单</h2>
                  <span className="muted">有效回仓单 {activeReturnCount} 张</span>
                </div>
                <div className="record-grid">
                  {state.returns.length === 0 ? <div className="empty">暂无回仓单</div> : state.returns.map((ret) => (
                    <article className="record" key={ret.id}>
                      <div className="record-head">
                        <p className="record-title">{ret.returnNo} ← {ret.orderNo}</p>
                        <span className={`status ${STATUS_CLASS[ret.status]}`}>{ret.status}</span>
                      </div>
                      <div className="details">
                        <span>取件时段: {ret.slot}</span>
                        <span>司机: {ret.driver}</span>
                        <span>车辆: {ret.vehicle}</span>
                        <span>原单重量: {ret.expectedWeight}kg</span>
                        {ret.actualWeight != null && <span>回仓重量: {ret.actualWeight}kg</span>}
                        {ret.completedAt && <span>完成时间: {fmtTime(ret.completedAt)}</span>}
                      </div>
                      <p className="note">原因：{ret.reason}{ret.reviewNote ? `；复核：${ret.reviewNote}` : ""}</p>
                      <div className="actions">
                        {ret.status === "待接单" && (
                          <>
                            <button type="button" onClick={() => handleAccept(ret)}>接单</button>
                            <button className="secondary" type="button" onClick={() => handleCancelReturn(ret)}>取消</button>
                          </>
                        )}
                        {ret.status === "待取件" && (
                          <>
                            <button type="button" onClick={() => setModal({ kind: "weight", ret })}>回仓登记</button>
                            <button className="secondary" type="button" onClick={() => handleCancelReturn(ret)}>取消</button>
                          </>
                        )}
                        {ret.status === "待复核" && (
                          <>
                            <button type="button" onClick={() => setModal({ kind: "review", ret })}>复核通过</button>
                            <button className="secondary" type="button" onClick={() => handleCancelReturn(ret)}>取消</button>
                          </>
                        )}
                        {(ret.status === "已回仓" || ret.status === "已取消") && (
                          <span className="muted">{ret.status === "已回仓" ? "司机已释放，修订已写入修订链" : "已取消，不占司机时段"}</span>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}

            {tab === "docs" && (
              <>
                <div className="toolbar">
                  <h2>签收单</h2>
                  <span className="muted">原始凭证，不可改写；后续变更以修订链为准</span>
                </div>
                {state.receipts.length === 0 ? <div className="empty">暂无签收单</div> : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr><th>签收单号</th><th>订单</th><th>司机</th><th>车辆</th><th>时段</th><th>重量</th><th>目的地</th><th>签收时间</th></tr>
                      </thead>
                      <tbody>
                        {state.receipts.map((r) => (
                          <tr key={r.id}>
                            <td>{r.receiptNo}</td>
                            <td>{r.orderNo}</td>
                            <td>{r.driver}</td>
                            <td>{r.vehicle}</td>
                            <td>{r.slot}</td>
                            <td>{r.weight}kg</td>
                            <td>{r.destination}</td>
                            <td>{fmtTime(r.signedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="toolbar section-gap">
                  <h2>修订链</h2>
                  <span className="muted">按订单串联拒收、复核与回仓完成记录</span>
                </div>
                {revisionGroups.length === 0 ? <div className="empty">暂无修订</div> : revisionGroups.map((group) => (
                  <div className="rev-group" key={group.orderNo}>
                    <p className="rev-order">{group.orderNo}</p>
                    <div className="timeline">
                      {group.items.map((rev) => (
                        <div className="tl-item" key={rev.id}>
                          <span className="tl-seq">{rev.seq}</span>
                          <div>
                            <p className="tl-head">
                              <span className="tl-type">{rev.type}</span>
                              <strong>{rev.reason}</strong>
                              <span className="muted">{fmtTime(rev.createdAt)}</span>
                            </p>
                            <p className="tl-detail">{rev.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === "conflicts" && (
              <>
                <div className="toolbar">
                  <h2>冲突记录</h2>
                  <span className="muted">被规则拦截或触发复核的事件，列出订单、司机、时段与触发规则</span>
                </div>
                {state.conflicts.length === 0 ? <div className="empty">暂无冲突记录</div> : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr><th>时间</th><th>订单</th><th>司机</th><th>时段</th><th>触发规则</th><th>详情</th></tr>
                      </thead>
                      <tbody>
                        {state.conflicts.map((c) => (
                          <tr key={c.id}>
                            <td>{fmtTime(c.createdAt)}</td>
                            <td>{c.orderNo}</td>
                            <td>{c.driver}</td>
                            <td>{c.slot}</td>
                            <td>{c.rule}</td>
                            <td>{c.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </section>

        {modal?.kind === "reject" && (
          <RejectModal
            order={modal.order}
            state={state}
            onCancel={() => setModal(null)}
            onSubmit={(v) => handleRejectSubmit(modal.order, v)}
          />
        )}
        {modal?.kind === "weight" && (
          <WeightModal
            ret={modal.ret}
            onCancel={() => setModal(null)}
            onSubmit={(w) => handleWeightSubmit(modal.ret, w)}
          />
        )}
        {modal?.kind === "review" && (
          <ReviewModal
            ret={modal.ret}
            onCancel={() => setModal(null)}
            onSubmit={(n) => handleReviewSubmit(modal.ret, n)}
          />
        )}
      </div>
    </main>
  );
}

function RejectModal({
  order,
  state,
  onCancel,
  onSubmit,
}: {
  order: Order;
  state: State;
  onCancel: () => void;
  onSubmit: (v: { reason: string; slot: string; driver: string; vehicle: string }) => void;
}) {
  const [reason, setReason] = useState("");
  const [slot, setSlot] = useState(order.slot);
  const [driver, setDriver] = useState(order.driver);
  const [vehicle, setVehicle] = useState(order.vehicle);
  const busy = driverTasks(state, driver, slot);

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>拒收并生成回仓单 · {order.orderNo}</h3>
        <div className="form-grid">
          <label>
            拒收原因
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="必填，例如：外包装破损，客户拒收" />
          </label>
          <label>
            取件时段
            <select value={slot} onChange={(e) => setSlot(e.target.value)}>
              {SLOTS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label>
            取件司机
            <select value={driver} onChange={(e) => setDriver(e.target.value)}>
              {DRIVERS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <label>
            取件车辆
            <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
              {VEHICLES.map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
          {busy.length > 0 && (
            <p className="hint">
              注意：{driver} 在 {slot} 已有任务（{busy.map((t) => `${t.kind} ${t.ref}`).join("、")}），回仓单可创建，但接单时会被规则 R2 拦截。
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>取消</button>
          <button type="button" disabled={!reason.trim()} onClick={() => onSubmit({ reason: reason.trim(), slot, driver, vehicle })}>
            生成回仓单
          </button>
        </div>
      </div>
    </div>
  );
}

function WeightModal({
  ret,
  onCancel,
  onSubmit,
}: {
  ret: ReturnOrder;
  onCancel: () => void;
  onSubmit: (weight: number) => void;
}) {
  const [weight, setWeight] = useState(String(ret.expectedWeight));
  const num = Number(weight);
  const valid = weight.trim() !== "" && Number.isFinite(num) && num > 0;
  const mismatch = valid && num !== ret.expectedWeight;

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>回仓登记 · {ret.returnNo}</h3>
        <div className="form-grid">
          <p className="muted">原单重量 {ret.expectedWeight}kg，请录入实际回仓重量。</p>
          <label>
            回仓重量kg
            <input type="number" min={1} value={weight} onChange={(e) => setWeight(e.target.value)} />
          </label>
          {mismatch && (
            <p className="hint">回仓重量与原单不一致，提交后将转入待复核（规则 R3），复核通过才能完成回仓。</p>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>取消</button>
          <button type="button" disabled={!valid} onClick={() => onSubmit(num)}>确认回仓</button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({
  ret,
  onCancel,
  onSubmit,
}: {
  ret: ReturnOrder;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const actual = ret.actualWeight ?? ret.expectedWeight;
  const diff = actual - ret.expectedWeight;

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>重量复核 · {ret.returnNo}</h3>
        <div className="form-grid">
          <p className="muted">原单 {ret.expectedWeight}kg，回仓 {actual}kg，差异 {diff}kg。复核通过后将完成回仓并释放司机。</p>
          <label>
            复核说明
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="必填，例如：差异为随车配件留存客户处" />
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>取消</button>
          <button type="button" disabled={!note.trim()} onClick={() => onSubmit(note.trim())}>复核通过并回仓</button>
        </div>
      </div>
    </div>
  );
}
