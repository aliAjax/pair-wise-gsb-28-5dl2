export type OrderStatus = "待分配" | "已分配" | "已签收" | "拒收" | "已回仓";
export type ReturnStatus = "待接单" | "待取件" | "待复核" | "已回仓" | "已取消";
export type RevisionType = "拒收" | "重量复核" | "回仓完成";

export interface Order {
  id: string;
  orderNo: string;
  destination: string;
  weight: number;
  driver: string;
  vehicle: string;
  slot: string;
  status: OrderStatus;
  notes: string;
  createdAt: string;
}

export interface ReturnOrder {
  id: string;
  returnNo: string;
  orderId: string;
  orderNo: string;
  slot: string;
  driver: string;
  vehicle: string;
  reason: string;
  status: ReturnStatus;
  expectedWeight: number;
  actualWeight: number | null;
  reviewNote: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** 签收单：原始凭证，只增不改，后续变更一律走修订链 */
export interface Receipt {
  id: string;
  receiptNo: string;
  orderId: string;
  orderNo: string;
  driver: string;
  vehicle: string;
  slot: string;
  weight: number;
  destination: string;
  signedAt: string;
}

export interface Revision {
  id: string;
  orderId: string;
  orderNo: string;
  seq: number;
  type: RevisionType;
  reason: string;
  detail: string;
  createdAt: string;
}

export interface Conflict {
  id: string;
  orderNo: string;
  driver: string;
  slot: string;
  rule: string;
  detail: string;
  createdAt: string;
}

export interface State {
  orders: Order[];
  returns: ReturnOrder[];
  receipts: Receipt[];
  revisions: Revision[];
  conflicts: Conflict[];
}

export const DRIVERS = ["刘师傅", "赵师傅", "孙师傅"];
export const VEHICLES = ["沪A·1001", "沪B·2002", "沪C·3003"];
export const SLOTS = ["09:00-11:00", "11:00-13:00", "13:00-15:00", "15:00-17:00", "17:00-19:00"];

export const RULES = {
  DUP_RETURN: "R1·同一订单同时只能有一张有效回仓单",
  DRIVER_BUSY: "R2·司机在该时段已有任务，不能接单/排班",
  WEIGHT_REVIEW: "R3·回仓重量与原单不一致须先复核",
} as const;

/** 有效回仓单：未回仓也未取消 */
export const ACTIVE_RETURN_STATUSES: ReturnStatus[] = ["待接单", "待取件", "待复核"];
/** 接单后占用司机时段的回仓单状态（回仓完成或取消即释放） */
export const OCCUPYING_RETURN_STATUSES: ReturnStatus[] = ["待取件", "待复核"];

export interface DriverTask {
  kind: "配送" | "回仓";
  ref: string;
  id: string;
}

export function uid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shortSlot(slot: string) {
  return slot.replace(/:00/g, "");
}

export function activeReturnForOrder(returns: ReturnOrder[], orderId: string) {
  return returns.find((r) => r.orderId === orderId && ACTIVE_RETURN_STATUSES.includes(r.status));
}

export function latestReturnForOrder(returns: ReturnOrder[], orderId: string) {
  const active = activeReturnForOrder(returns, orderId);
  if (active) return active;
  return returns
    .filter((r) => r.orderId === orderId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** 司机在某时段已占用的任务：配送中的订单 + 已接单的回仓单 */
export function driverTasks(state: State, driver: string, slot: string): DriverTask[] {
  const deliveries = state.orders
    .filter((o) => o.driver === driver && o.slot === slot && o.status === "已分配")
    .map((o): DriverTask => ({ kind: "配送", ref: o.orderNo, id: o.id }));
  const pickups = state.returns
    .filter((r) => r.driver === driver && r.slot === slot && OCCUPYING_RETURN_STATUSES.includes(r.status))
    .map((r): DriverTask => ({ kind: "回仓", ref: r.returnNo, id: r.id }));
  return [...deliveries, ...pickups];
}

export function nextReturnNo(returns: ReturnOrder[]) {
  return `RW-${String(returns.length + 1).padStart(4, "0")}`;
}

export function nextReceiptNo(receipts: Receipt[]) {
  return `POD-${String(receipts.length + 1).padStart(4, "0")}`;
}

export function nextSeq(revisions: Revision[], orderId: string) {
  return revisions.filter((r) => r.orderId === orderId).length + 1;
}

export const STATUS_CLASS: Record<string, string> = {
  待分配: "st-pending",
  已分配: "st-assigned",
  已签收: "st-signed",
  拒收: "st-rejected",
  已回仓: "st-returned",
  待接单: "st-pending",
  待取件: "st-assigned",
  待复核: "st-review",
  已取消: "st-cancelled",
};
