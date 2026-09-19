import { useMemo, useState } from "react";
import type { FormEvent } from "react";

/* ================= 领域常量 ================= */

const DRIVERS = ["刘师傅", "赵师傅", "孙师傅"];
const VEHICLES = ["沪A·D210", "沪B·K318", "沪C·M552"];
const SLOTS = ["上午 09:00-12:00", "下午 13:00-17:00", "晚间 18:00-21:00"];

const ORDER_STATUS = {
  PENDING: "待分配",
  ASSIGNED: "已分配",
  SIGNED: "已签收",
  RETURNING: "回仓中",
  RETURNED: "已回仓",
};
const ORDER_STATUSES = Object.values(ORDER_STATUS);

const RETURN_STATUS = {
  PICKUP: "待取件",
  REVIEW: "待复核",
  DONE: "已回仓",
  CANCELLED: "已取消",
};
/** 有效回仓单：占用司机时段、且阻止同一订单再开回仓单 */
const ACTIVE_RETURN_STATUSES = [RETURN_STATUS.PICKUP, RETURN_STATUS.REVIEW];

/** 触发规则文案（冲突记录中展示） */
const RULES = {
  UNIQUE_ORDER_NO: "单号唯一：订单号不可重复",
  SINGLE_ACTIVE_RETURN: "唯一有效回仓单：同一订单同时只能有一张有效回仓单",
  SLOT_BUSY: "时段占用：司机在取件时段已有任务，不能接单",
  STATUS_GATE: "状态校验：仅已分配/已签收订单可生成回仓单",
  WEIGHT_REVIEW: "重量复核：回仓重量与原单不一致，须先复核",
};

const STORAGE_KEY = "hxwlfront-14-schedule";
const STATE_VERSION = 2;

/* ================= 类型 ================= */

type Order = {
  id: string;
  orderNo: string;
  destination: string;
  weight: number;
  driver: string;
  vehicle: string;
  slot: string;
  status: string;
  notes: string;
  createdAt: string;
};

type ReturnOrder = {
  id: string;
  returnNo: string;
  orderId: string;
  orderNo: string;
  originWeight: number;
  returnWeight: number | null;
  slot: string;
  driver: string;
  vehicle: string;
  reason: string;
  status: string;
  /** 生成回仓单前订单的状态，取消回仓时恢复 */
  fromStatus: string;
  createdAt: string;
  completedAt: string | null;
};

/** 签收单/拒收单：只读，任何流程不得改写 */
type Receipt = {
  id: string;
  orderId: string;
  orderNo: string;
  type: "签收单" | "拒收单";
  weight: number;
  driver: string;
  createdAt: string;
};

type Revision = {
  id: string;
  orderId: string;
  orderNo: string;
  seq: number;
  reason: string;
  detail: string;
  createdAt: string;
};

type Conflict = {
  id: string;
  orderNo: string;
  driver: string;
  slot: string;
  rule: string;
  detail: string;
  createdAt: string;
};

type AppState = {
  version: number;
  orders: Order[];
  returns: ReturnOrder[];
  receipts: Receipt[];
  revisions: Revision[];
  conflicts: Conflict[];
};

/* ================= 持久化 ================= */

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fmt(isoText: string) {
  return new Date(isoText).toLocaleString("zh-CN", { hour12: false });
}

function uid() {
  return crypto.randomUUID();
}

function seedState(): AppState {
  const day = 86400000;
  const orders: Order[] = [
    { id: "seed-o1", orderNo: "ORD-9012", destination: "浦东", weight: 260, driver: "刘师傅", vehicle: "沪A·D210", slot: SLOTS[0], status: ORDER_STATUS.ASSIGNED, notes: "上午配送", createdAt: iso(-2 * day) },
    { id: "seed-o2", orderNo: "ORD-9031", destination: "嘉定", weight: 140, driver: "赵师傅", vehicle: "沪B·K318", slot: SLOTS[1], status: ORDER_STATUS.PENDING, notes: "待排班", createdAt: iso(-day) },
    { id: "seed-o3", orderNo: "ORD-9044", destination: "松江", weight: 320, driver: "孙师傅", vehicle: "沪C·M552", slot: SLOTS[1], status: ORDER_STATUS.SIGNED, notes: "客户已签收", createdAt: iso(-3 * day) },
    { id: "seed-o4", orderNo: "ORD-9050", destination: "青浦", weight: 180, driver: "刘师傅", vehicle: "沪A·D210", slot: SLOTS[1], status: ORDER_STATUS.RETURNING, notes: "客户拒收，等待回仓取件", createdAt: iso(-day) },
  ];
  const receipts: Receipt[] = [
    { id: "seed-r1", orderId: "seed-o3", orderNo: "ORD-9044", type: "签收单", weight: 320, driver: "孙师傅", createdAt: iso(-2 * day) },
    { id: "seed-r2", orderId: "seed-o4", orderNo: "ORD-9050", type: "拒收单", weight: 180, driver: "刘师傅", createdAt: iso(-3600000) },
  ];
  const returns: ReturnOrder[] = [
    { id: "seed-t1", returnNo: "RT-0001", orderId: "seed-o4", orderNo: "ORD-9050", originWeight: 180, returnWeight: null, slot: SLOTS[1], driver: "赵师傅", vehicle: "沪B·K318", reason: "包装破损，客户拒收", status: RETURN_STATUS.PICKUP, fromStatus: ORDER_STATUS.ASSIGNED, createdAt: iso(-3600000), completedAt: null },
  ];
  const revisions: Revision[] = [
    { id: "seed-v1", orderId: "seed-o4", orderNo: "ORD-9050", seq: 1, reason: "包装破损，客户拒收", detail: "拒收转回仓，生成回仓单 RT-0001（赵师傅 · 下午 13:00-17:00 · 沪B·K318）", createdAt: iso(-3600000) },
  ];
  return { version: STATE_VERSION, orders, returns, receipts, revisions, conflicts: [] };
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.orders)) return seedState();
    return {
      version: STATE_VERSION,
      orders: parsed.orders,
      returns: parsed.returns ?? [],
      receipts: parsed.receipts ?? [],
      revisions: parsed.revisions ?? [],
      conflicts: parsed.conflicts ?? [],
    };
  } catch {
    return seedState();
  }
}

function saveState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ================= 规则与派生 ================= */

/** 司机在某时段已占用的任务（已分配配送单 + 有效回仓单），用于时段冲突检测 */
function driverTasks(state: AppState, driver: string, slot: string, excludeOrderId?: string) {
  const deliveries = state.orders
    .filter(
      (o) =>
        o.status === ORDER_STATUS.ASSIGNED && o.driver === driver && o.slot === slot && o.id !== excludeOrderId
    )
    .map((o) => `配送 ${o.orderNo}`);
  const pickups = state.returns
    .filter((r) => ACTIVE_RETURN_STATUSES.includes(r.status) && r.driver === driver && r.slot === slot)
    .map((r) => `回仓取件 ${r.returnNo}`);
  return [...deliveries, ...pickups];
}

function makeRevision(state: AppState, orderId: string, orderNo: string, reason: string, detail: string): Revision {
  const seq = state.revisions.filter((r) => r.orderId === orderId).length + 1;
  return { id: uid(), orderId, orderNo, seq, reason, detail, createdAt: iso() };
}

const STATUS_CLASS: Record<string, string> = {
  待分配: "st-pending",
  已分配: "st-assigned",
  已签收: "st-signed",
  回仓中: "st-returning",
  已回仓: "st-returned",
  待取件: "st-assigned",
  待复核: "st-review",
  已取消: "st-cancelled",
  签收单: "st-signed",
  拒收单: "st-review",
};

/* ================= 组件 ================= */

const blankOrderForm = { orderNo: "", destination: "", weight: 0, driver: "", vehicle: "", slot: "" };
const blankReturnForm = { orderId: "", slot: "", driver: "", vehicle: "", reason: "" };

export default function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [orderForm, setOrderForm] = useState(blankOrderForm);
  const [note, setNote] = useState("");
  const [returnForm, setReturnForm] = useState(blankReturnForm);
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("全部司机");

  function commit(next: AppState) {
    setState(next);
    saveState(next);
  }

  /* ---------- 派生数据 ---------- */

  const activeReturnByOrder = useMemo(() => {
    const map = new Map<string, ReturnOrder>();
    state.returns.forEach((r) => {
      if (ACTIVE_RETURN_STATUSES.includes(r.status)) map.set(r.orderId, r);
    });
    return map;
  }, [state.returns]);

  const eligibleOrders = useMemo(
    () =>
      state.orders.filter(
        (o) => (o.status === ORDER_STATUS.ASSIGNED || o.status === ORDER_STATUS.SIGNED) && !activeReturnByOrder.has(o.id)
      ),
    [state.orders, activeReturnByOrder]
  );

  const filteredOrders = useMemo(
    () => (filter === "全部司机" ? state.orders : state.orders.filter((o) => o.driver === filter)),
    [state.orders, filter]
  );

  const metrics = useMemo(() => {
    const assigned = state.orders.filter((o) => o.status === ORDER_STATUS.ASSIGNED).length;
    const returning = state.returns.filter((r) => ACTIVE_RETURN_STATUSES.includes(r.status)).length;
    const reviewing = state.returns.filter((r) => r.status === RETURN_STATUS.REVIEW).length;
    const weight = state.orders.reduce((acc, o) => acc + Number(o.weight || 0), 0);
    return [
      { label: "订单数", value: state.orders.length },
      { label: "已分配", value: assigned },
      { label: "回仓中", value: returning },
      { label: "待复核", value: reviewing },
      { label: "总重量kg", value: weight },
    ];
  }, [state]);

  const chartRows = ORDER_STATUSES.map((status) => ({
    status,
    value: state.orders.filter((o) => o.status === status).length,
  }));
  const maxChart = Math.max(1, ...chartRows.map((row) => row.value));

  const revisionChains = useMemo(() => {
    const groups = new Map<string, Revision[]>();
    state.revisions.forEach((rev) => {
      const list = groups.get(rev.orderNo) ?? [];
      list.push(rev);
      groups.set(rev.orderNo, list);
    });
    return [...groups.entries()].map(([orderNo, list]) => ({
      orderNo,
      list: [...list].sort((a, b) => a.seq - b.seq),
    }));
  }, [state.revisions]);

  /* ---------- 冲突与修订 ---------- */

  function logConflict(base: AppState, c: Omit<Conflict, "id" | "createdAt">): AppState {
    const entry: Conflict = { ...c, id: uid(), createdAt: iso() };
    return { ...base, conflicts: [entry, ...base.conflicts].slice(0, 50) };
  }

  /* ---------- 订单动作 ---------- */

  function handleAddOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const orderNo = orderForm.orderNo.trim();
    if (state.orders.some((o) => o.orderNo === orderNo)) {
      commit(
        logConflict(state, {
          orderNo,
          driver: orderForm.driver,
          slot: orderForm.slot,
          rule: RULES.UNIQUE_ORDER_NO,
          detail: "已存在相同订单号，未重复创建",
        })
      );
      return;
    }
    const order: Order = {
      id: uid(),
      orderNo,
      destination: orderForm.destination.trim(),
      weight: Number(orderForm.weight),
      driver: orderForm.driver,
      vehicle: orderForm.vehicle,
      slot: orderForm.slot,
      status: ORDER_STATUS.PENDING,
      notes: note.trim() || "暂无备注",
      createdAt: iso(),
    };
    commit({ ...state, orders: [order, ...state.orders] });
    setOrderForm(blankOrderForm);
    setNote("");
  }

  function assignOrder(order: Order) {
    const tasks = driverTasks(state, order.driver, order.slot);
    if (tasks.length > 0) {
      commit(
        logConflict(state, {
          orderNo: order.orderNo,
          driver: order.driver,
          slot: order.slot,
          rule: RULES.SLOT_BUSY,
          detail: `冲突任务：${tasks.join("、")}`,
        })
      );
      return;
    }
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? { ...o, status: ORDER_STATUS.ASSIGNED } : o)),
    });
  }

  function signOrder(order: Order) {
    const receipt: Receipt = {
      id: uid(),
      orderId: order.id,
      orderNo: order.orderNo,
      type: "签收单",
      weight: order.weight,
      driver: order.driver,
      createdAt: iso(),
    };
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? { ...o, status: ORDER_STATUS.SIGNED } : o)),
      receipts: [receipt, ...state.receipts],
    });
  }

  function deleteOrder(order: Order) {
    commit({ ...state, orders: state.orders.filter((o) => o.id !== order.id) });
  }

  /* ---------- 回仓动作 ---------- */

  function prefillReturn(order: Order) {
    setReturnForm({ orderId: order.id, slot: order.slot, driver: order.driver, vehicle: order.vehicle, reason: "" });
    document.getElementById("return-form")?.scrollIntoView({ behavior: "smooth" });
  }

  function handleCreateReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const order = state.orders.find((o) => o.id === returnForm.orderId);
    if (!order) return;

    if (order.status !== ORDER_STATUS.ASSIGNED && order.status !== ORDER_STATUS.SIGNED) {
      commit(
        logConflict(state, {
          orderNo: order.orderNo,
          driver: returnForm.driver,
          slot: returnForm.slot,
          rule: RULES.STATUS_GATE,
          detail: `当前状态「${order.status}」不可生成回仓单`,
        })
      );
      return;
    }

    const existing = activeReturnByOrder.get(order.id);
    if (existing) {
      commit(
        logConflict(state, {
          orderNo: order.orderNo,
          driver: returnForm.driver,
          slot: returnForm.slot,
          rule: RULES.SINGLE_ACTIVE_RETURN,
          detail: `已存在有效回仓单 ${existing.returnNo}（${existing.status}）`,
        })
      );
      return;
    }

    const tasks = driverTasks(state, returnForm.driver, returnForm.slot, order.id);
    if (tasks.length > 0) {
      commit(
        logConflict(state, {
          orderNo: order.orderNo,
          driver: returnForm.driver,
          slot: returnForm.slot,
          rule: RULES.SLOT_BUSY,
          detail: `冲突任务：${tasks.join("、")}`,
        })
      );
      return;
    }

    const returnNo = `RT-${String(state.returns.length + 1).padStart(4, "0")}`;
    const returnOrder: ReturnOrder = {
      id: uid(),
      returnNo,
      orderId: order.id,
      orderNo: order.orderNo,
      originWeight: order.weight,
      returnWeight: null,
      slot: returnForm.slot,
      driver: returnForm.driver,
      vehicle: returnForm.vehicle,
      reason: returnForm.reason.trim(),
      status: RETURN_STATUS.PICKUP,
      fromStatus: order.status,
      createdAt: iso(),
      completedAt: null,
    };
    const isReject = order.status === ORDER_STATUS.ASSIGNED;
    const receipts = isReject
      ? [
          {
            id: uid(),
            orderId: order.id,
            orderNo: order.orderNo,
            type: "拒收单" as const,
            weight: order.weight,
            driver: order.driver,
            createdAt: iso(),
          },
          ...state.receipts,
        ]
      : state.receipts;
    const revision = makeRevision(
      state,
      order.id,
      order.orderNo,
      returnOrder.reason,
      `${isReject ? "拒收转回仓" : "售后回仓"}，生成回仓单 ${returnNo}（${returnOrder.driver} · ${returnOrder.slot} · ${returnOrder.vehicle}）`
    );
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? { ...o, status: ORDER_STATUS.RETURNING } : o)),
      returns: [returnOrder, ...state.returns],
      receipts,
      revisions: [...state.revisions, revision],
    });
    setReturnForm(blankReturnForm);
  }

  /** 回仓完成：释放司机（时段占用随有效状态结束而释放）并生成带原因的修订 */
  function finalizeReturn(base: AppState, rt: ReturnOrder, weight: number) {
    const diff = weight - rt.originWeight;
    const weightText =
      diff === 0 ? `回仓重量 ${weight}kg，与原单一致` : `回仓重量 ${weight}kg，与原单差异 ${diff > 0 ? "+" : ""}${diff}kg，已复核`;
    const revision = makeRevision(
      base,
      rt.orderId,
      rt.orderNo,
      rt.reason,
      `回仓完成（${rt.returnNo}）：${weightText}，司机 ${rt.driver} 已释放；原签收单保持只读不改写`
    );
    commit({
      ...base,
      orders: base.orders.map((o) => (o.id === rt.orderId ? { ...o, status: ORDER_STATUS.RETURNED } : o)),
      returns: base.returns.map((r) =>
        r.id === rt.id ? { ...r, status: RETURN_STATUS.DONE, returnWeight: weight, completedAt: iso() } : r
      ),
      revisions: [...base.revisions, revision],
    });
    setWeightDrafts((drafts) => {
      const next = { ...drafts };
      delete next[rt.id];
      return next;
    });
  }

  function completeReturn(rt: ReturnOrder) {
    const weight = Number(weightDrafts[rt.id] ?? rt.originWeight);
    if (!Number.isFinite(weight) || weight <= 0) return;
    if (weight !== rt.originWeight) {
      // 重量不一致：先转入待复核，并记录触发的复核规则
      const moved: AppState = {
        ...state,
        returns: state.returns.map((r) =>
          r.id === rt.id ? { ...r, status: RETURN_STATUS.REVIEW, returnWeight: weight } : r
        ),
      };
      commit(
        logConflict(moved, {
          orderNo: rt.orderNo,
          driver: rt.driver,
          slot: rt.slot,
          rule: RULES.WEIGHT_REVIEW,
          detail: `原单 ${rt.originWeight}kg ≠ 回仓 ${weight}kg，回仓单 ${rt.returnNo} 已转入待复核`,
        })
      );
      return;
    }
    finalizeReturn(state, rt, weight);
  }

  function reviewReturn(rt: ReturnOrder, pass: boolean) {
    if (pass) {
      finalizeReturn(state, rt, Number(rt.returnWeight ?? rt.originWeight));
      return;
    }
    const revision = makeRevision(
      state,
      rt.orderId,
      rt.orderNo,
      rt.reason,
      `重量复核驳回（原单 ${rt.originWeight}kg / 回仓 ${rt.returnWeight}kg），回仓单 ${rt.returnNo} 退回待取件`
    );
    commit({
      ...state,
      returns: state.returns.map((r) =>
        r.id === rt.id ? { ...r, status: RETURN_STATUS.PICKUP, returnWeight: null } : r
      ),
      revisions: [...state.revisions, revision],
    });
  }

  function cancelReturn(rt: ReturnOrder) {
    const revision = makeRevision(
      state,
      rt.orderId,
      rt.orderNo,
      rt.reason,
      `回仓单 ${rt.returnNo} 已取消，司机 ${rt.driver} 时段释放，订单恢复为「${rt.fromStatus}」`
    );
    commit({
      ...state,
      orders: state.orders.map((o) => (o.id === rt.orderId ? { ...o, status: rt.fromStatus } : o)),
      returns: state.returns.map((r) => (r.id === rt.id ? { ...r, status: RETURN_STATUS.CANCELLED } : r)),
      revisions: [...state.revisions, revision],
    });
  }

  /* ================= 渲染 ================= */

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">物流行业前端最小闭环 · 逆向回仓</p>
            <h1>配送排班与逆向回仓闭环</h1>
            <p className="subtitle">
              拒收/售后生成回仓单（原订单 · 取件时段 · 司机 · 车辆 · 原因）→ 取件回仓 → 重量不一致先复核 →
              完成释放司机并生成带原因的修订，原签收单只读不改写。
            </p>
          </div>
          <div className="stack">
            <span className="tag">React</span>
            <span className="tag">TypeScript</span>
            <span className="tag">localStorage 持久化</span>
            <button type="button" className="secondary" onClick={() => commit(seedState())}>
              重置演示数据
            </button>
          </div>
        </header>

        <section className="metrics">
          {metrics.map((metric) => (
            <article className="metric" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </article>
          ))}
        </section>

        {state.conflicts.length > 0 && (
          <section className="panel conflict-panel">
            <div className="toolbar">
              <h2>冲突拦截（{state.conflicts.length}）</h2>
              <button type="button" className="secondary" onClick={() => commit({ ...state, conflicts: [] })}>
                清空记录
              </button>
            </div>
            <div className="record-grid">
              {state.conflicts.map((c) => (
                <div className="conflict" key={c.id}>
                  <strong>{c.orderNo}</strong>
                  <span>司机：{c.driver || "—"}</span>
                  <span>时段：{c.slot || "—"}</span>
                  <span className="rule">触发规则：{c.rule}</span>
                  <span className="conflict-detail">{c.detail}</span>
                  <time>{fmt(c.createdAt)}</time>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="workspace">
          <form className="panel" onSubmit={handleAddOrder}>
            <h2>新增待分配订单</h2>
            <div className="form-grid">
              <label>
                订单号
                <input
                  value={orderForm.orderNo}
                  onChange={(e) => setOrderForm({ ...orderForm, orderNo: e.target.value })}
                  placeholder="ORD-XXXX"
                  required
                />
              </label>
              <label>
                目的地
                <input
                  value={orderForm.destination}
                  onChange={(e) => setOrderForm({ ...orderForm, destination: e.target.value })}
                  required
                />
              </label>
              <label>
                重量kg
                <input
                  type="number"
                  min={1}
                  value={orderForm.weight}
                  onChange={(e) => setOrderForm({ ...orderForm, weight: Number(e.target.value) })}
                  required
                />
              </label>
              <label>
                司机
                <select
                  value={orderForm.driver}
                  onChange={(e) => setOrderForm({ ...orderForm, driver: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {DRIVERS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label>
                车辆
                <select
                  value={orderForm.vehicle}
                  onChange={(e) => setOrderForm({ ...orderForm, vehicle: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {VEHICLES.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                配送时段
                <select
                  value={orderForm.slot}
                  onChange={(e) => setOrderForm({ ...orderForm, slot: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {SLOTS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                备注
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="填写处理说明或现场备注" />
              </label>
              <button type="submit">加入待分配</button>
            </div>
          </form>

          <section className="list-panel">
            <div className="toolbar">
              <h2>订单列表</h2>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                {["全部司机", ...DRIVERS].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>

            <div className="record-grid">
              {filteredOrders.length === 0 ? (
                <div className="empty">暂无匹配数据</div>
              ) : (
                filteredOrders.map((order) => {
                  const activeReturn = activeReturnByOrder.get(order.id);
                  return (
                    <article className="record" key={order.id}>
                      <div className="record-head">
                        <p className="record-title">
                          {order.orderNo} / {order.destination}
                        </p>
                        <span className={`status ${STATUS_CLASS[order.status] ?? ""}`}>{order.status}</span>
                      </div>
                      <div className="details">
                        <span>司机: {order.driver}</span>
                        <span>车辆: {order.vehicle}</span>
                        <span>时段: {order.slot}</span>
                        <span>重量: {order.weight}kg</span>
                      </div>
                      <p className="note">{order.notes}</p>
                      {activeReturn && (
                        <p className="note warn">
                          回仓单 {activeReturn.returnNo} · {activeReturn.status} · {activeReturn.driver} ·{" "}
                          {activeReturn.slot}
                        </p>
                      )}
                      <div className="actions">
                        {order.status === ORDER_STATUS.PENDING && (
                          <>
                            <button type="button" onClick={() => assignOrder(order)}>
                              确认分配
                            </button>
                            <button type="button" className="danger" onClick={() => deleteOrder(order)}>
                              删除
                            </button>
                          </>
                        )}
                        {order.status === ORDER_STATUS.ASSIGNED && (
                          <>
                            <button type="button" onClick={() => signOrder(order)}>
                              签收
                            </button>
                            <button type="button" className="secondary" onClick={() => prefillReturn(order)}>
                              拒收回仓
                            </button>
                          </>
                        )}
                        {order.status === ORDER_STATUS.SIGNED && (
                          <button type="button" className="secondary" onClick={() => prefillReturn(order)}>
                            申请回仓（售后）
                          </button>
                        )}
                        {order.status === ORDER_STATUS.RETURNED && <span className="tag">已回仓 · 见修订链</span>}
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            <div className="mini-chart">
              {chartRows.map((row) => (
                <div className="bar" key={row.status}>
                  <span>{row.status}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(row.value / maxChart) * 100}%` }} />
                  </div>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section className="workspace">
          <form className="panel" id="return-form" onSubmit={handleCreateReturn}>
            <h2>生成回仓单（拒收 / 售后）</h2>
            <div className="form-grid">
              <label>
                原订单
                <select
                  value={returnForm.orderId}
                  onChange={(e) => {
                    const order = state.orders.find((o) => o.id === e.target.value);
                    setReturnForm(
                      order
                        ? { orderId: order.id, slot: order.slot, driver: order.driver, vehicle: order.vehicle, reason: returnForm.reason }
                        : { ...returnForm, orderId: "" }
                    );
                  }}
                  required
                >
                  <option value="">请选择（已分配 / 已签收）</option>
                  {eligibleOrders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.orderNo} · {o.destination} · {o.weight}kg（{o.status}）
                    </option>
                  ))}
                </select>
              </label>
              <label>
                取件时段
                <select
                  value={returnForm.slot}
                  onChange={(e) => setReturnForm({ ...returnForm, slot: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {SLOTS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                取件司机
                <select
                  value={returnForm.driver}
                  onChange={(e) => setReturnForm({ ...returnForm, driver: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {DRIVERS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label>
                取件车辆
                <select
                  value={returnForm.vehicle}
                  onChange={(e) => setReturnForm({ ...returnForm, vehicle: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {VEHICLES.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                回仓原因
                <textarea
                  value={returnForm.reason}
                  onChange={(e) => setReturnForm({ ...returnForm, reason: e.target.value })}
                  placeholder="如：包装破损，客户拒收"
                  required
                />
              </label>
              <button type="submit">生成回仓单</button>
              <p className="hint">
                校验规则：同一订单仅一张有效回仓单；司机在取件时段已有任务（配送或回仓取件）不能接单。
              </p>
            </div>
          </form>

          <section className="list-panel">
            <div className="toolbar">
              <h2>回仓单</h2>
              <span className="tag">有效 {state.returns.filter((r) => ACTIVE_RETURN_STATUSES.includes(r.status)).length} 张</span>
            </div>
            <div className="record-grid">
              {state.returns.length === 0 ? (
                <div className="empty">暂无回仓单</div>
              ) : (
                state.returns.map((rt) => (
                  <article className="record" key={rt.id}>
                    <div className="record-head">
                      <p className="record-title">
                        {rt.returnNo} ← {rt.orderNo}
                      </p>
                      <span className={`status ${STATUS_CLASS[rt.status] ?? ""}`}>{rt.status}</span>
                    </div>
                    <div className="details">
                      <span>取件时段: {rt.slot}</span>
                      <span>司机: {rt.driver}</span>
                      <span>车辆: {rt.vehicle}</span>
                      <span>原单重量: {rt.originWeight}kg</span>
                      {rt.returnWeight !== null && <span>回仓重量: {rt.returnWeight}kg</span>}
                      <span>创建: {fmt(rt.createdAt)}</span>
                      {rt.completedAt && <span>完成: {fmt(rt.completedAt)}</span>}
                    </div>
                    <p className="note">原因：{rt.reason}</p>
                    {rt.status === RETURN_STATUS.REVIEW && (
                      <p className="note warn">
                        重量差异：原单 {rt.originWeight}kg vs 回仓 {rt.returnWeight}kg，须复核后才能完成
                      </p>
                    )}
                    <div className="actions">
                      {rt.status === RETURN_STATUS.PICKUP && (
                        <>
                          <input
                            className="weight-input"
                            type="number"
                            min={1}
                            aria-label="回仓重量kg"
                            value={weightDrafts[rt.id] ?? String(rt.originWeight)}
                            onChange={(e) => setWeightDrafts({ ...weightDrafts, [rt.id]: e.target.value })}
                          />
                          <button type="button" onClick={() => completeReturn(rt)}>
                            确认回仓
                          </button>
                          <button type="button" className="secondary" onClick={() => cancelReturn(rt)}>
                            取消回仓单
                          </button>
                        </>
                      )}
                      {rt.status === RETURN_STATUS.REVIEW && (
                        <>
                          <button type="button" onClick={() => reviewReturn(rt, true)}>
                            复核通过
                          </button>
                          <button type="button" className="secondary" onClick={() => reviewReturn(rt, false)}>
                            退回重取
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </section>

        <section className="ledger">
          <div className="panel">
            <div className="toolbar">
              <h2>签收 / 拒收单</h2>
              <span className="tag">只读 · 不可改写</span>
            </div>
            <div className="record-grid">
              {state.receipts.length === 0 ? (
                <div className="empty">暂无单据</div>
              ) : (
                state.receipts.map((rc) => (
                  <div className="receipt" key={rc.id}>
                    <span className={`status ${STATUS_CLASS[rc.type] ?? ""}`}>{rc.type}</span>
                    <strong>{rc.orderNo}</strong>
                    <span>
                      {rc.weight}kg · {rc.driver}
                    </span>
                    <time>{fmt(rc.createdAt)}</time>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel">
            <div className="toolbar">
              <h2>修订链</h2>
              <span className="tag">{state.revisions.length} 条修订</span>
            </div>
            <div className="record-grid">
              {revisionChains.length === 0 ? (
                <div className="empty">暂无修订</div>
              ) : (
                revisionChains.map((chain) => (
                  <div className="chain" key={chain.orderNo}>
                    <h3>{chain.orderNo} 修订链</h3>
                    {chain.list.map((rev) => (
                      <div className="revision" key={rev.id}>
                        <span className="rev-seq">REV-{rev.seq}</span>
                        <div>
                          <p>{rev.detail}</p>
                          <p className="rev-meta">
                            原因：{rev.reason} · {fmt(rev.createdAt)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
