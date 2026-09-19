import { RULES, State } from "./domain";

const DAY = 86400000;
const HOUR = 3600000;

/** 演示数据：覆盖正向排班、拒收回仓、重量复核、修订链与冲突记录 */
export function buildSeed(): State {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString();

  return {
    orders: [
      { id: "seed-o2", orderNo: "ORD-9018", destination: "徐汇", weight: 120, driver: "刘师傅", vehicle: "沪A·1001", slot: "11:00-13:00", status: "已分配", notes: "下午前送达", createdAt: iso(now - DAY) },
      { id: "seed-o7", orderNo: "ORD-9047", destination: "闵行", weight: 100, driver: "刘师傅", vehicle: "沪A·1001", slot: "13:00-15:00", status: "拒收", notes: "客户拒收：少件", createdAt: iso(now - DAY) },
      { id: "seed-o3", orderNo: "ORD-9031", destination: "嘉定", weight: 140, driver: "赵师傅", vehicle: "沪B·2002", slot: "09:00-11:00", status: "待分配", notes: "待排班", createdAt: iso(now - DAY) },
      { id: "seed-o5", orderNo: "ORD-9040", destination: "青浦", weight: 90, driver: "赵师傅", vehicle: "沪B·2002", slot: "15:00-17:00", status: "拒收", notes: "客户当场拒收", createdAt: iso(now - 2 * DAY) },
      { id: "seed-o4", orderNo: "ORD-9036", destination: "松江", weight: 180, driver: "孙师傅", vehicle: "沪C·3003", slot: "13:00-15:00", status: "已分配", notes: "含易碎品", createdAt: iso(now - DAY) },
      { id: "seed-o6", orderNo: "ORD-9044", destination: "宝山", weight: 200, driver: "孙师傅", vehicle: "沪C·3003", slot: "09:00-11:00", status: "已回仓", notes: "签收后客户退货", createdAt: iso(now - 3 * DAY) },
      { id: "seed-o1", orderNo: "ORD-9012", destination: "浦东", weight: 260, driver: "刘师傅", vehicle: "沪A·1001", slot: "09:00-11:00", status: "已签收", notes: "上午配送", createdAt: iso(now - 2 * DAY) },
    ],
    returns: [
      { id: "seed-r3", returnNo: "RW-0003", orderId: "seed-o7", orderNo: "ORD-9047", slot: "15:00-17:00", driver: "刘师傅", vehicle: "沪A·1001", reason: "客户拒收：少件", status: "待复核", expectedWeight: 100, actualWeight: 75, reviewNote: null, createdAt: iso(now - DAY), completedAt: null },
      { id: "seed-r1", returnNo: "RW-0001", orderId: "seed-o5", orderNo: "ORD-9040", slot: "17:00-19:00", driver: "赵师傅", vehicle: "沪B·2002", reason: "外包装破损，客户拒收", status: "待取件", expectedWeight: 90, actualWeight: null, reviewNote: null, createdAt: iso(now - DAY), completedAt: null },
      { id: "seed-r2", returnNo: "RW-0002", orderId: "seed-o6", orderNo: "ORD-9044", slot: "15:00-17:00", driver: "孙师傅", vehicle: "沪C·3003", reason: "客户签收后退货：型号不符", status: "已回仓", expectedWeight: 200, actualWeight: 186, reviewNote: "差异14kg为随车配件留存客户处，复核确认", createdAt: iso(now - 2 * DAY), completedAt: iso(now - DAY) },
    ],
    receipts: [
      { id: "seed-p1", receiptNo: "POD-0001", orderId: "seed-o1", orderNo: "ORD-9012", driver: "刘师傅", vehicle: "沪A·1001", slot: "09:00-11:00", weight: 260, destination: "浦东", signedAt: iso(now - 2 * DAY + 3 * HOUR) },
      { id: "seed-p2", receiptNo: "POD-0002", orderId: "seed-o6", orderNo: "ORD-9044", driver: "孙师傅", vehicle: "沪C·3003", slot: "09:00-11:00", weight: 200, destination: "宝山", signedAt: iso(now - 3 * DAY + 3 * HOUR) },
    ],
    revisions: [
      { id: "seed-v1", orderId: "seed-o5", orderNo: "ORD-9040", seq: 1, type: "拒收", reason: "外包装破损，客户拒收", detail: "生成回仓单 RW-0001，取件时段 17:00-19:00，司机 赵师傅，车辆 沪B·2002", createdAt: iso(now - DAY) },
      { id: "seed-v2", orderId: "seed-o6", orderNo: "ORD-9044", seq: 1, type: "拒收", reason: "客户签收后退货：型号不符", detail: "原签收单 POD-0002 保留不改写；生成回仓单 RW-0002，取件时段 15:00-17:00，司机 孙师傅，车辆 沪C·3003", createdAt: iso(now - 2 * DAY) },
      { id: "seed-v3", orderId: "seed-o6", orderNo: "ORD-9044", seq: 2, type: "重量复核", reason: "回仓重量与原单不一致", detail: "原单 200kg，回仓 186kg，差异 -14kg；差异14kg为随车配件留存客户处，复核确认", createdAt: iso(now - 2 * DAY + HOUR) },
      { id: "seed-v4", orderId: "seed-o6", orderNo: "ORD-9044", seq: 3, type: "回仓完成", reason: "客户签收后退货：型号不符", detail: "回仓单 RW-0002 已回仓，回仓重量 186kg（已复核）；司机 孙师傅 已释放", createdAt: iso(now - DAY) },
      { id: "seed-v5", orderId: "seed-o7", orderNo: "ORD-9047", seq: 1, type: "拒收", reason: "客户拒收：少件", detail: "生成回仓单 RW-0003，取件时段 15:00-17:00，司机 刘师傅，车辆 沪A·1001", createdAt: iso(now - DAY) },
    ],
    conflicts: [
      { id: "seed-c2", orderNo: "ORD-9047", driver: "刘师傅", slot: "15:00-17:00", rule: RULES.WEIGHT_REVIEW, detail: "回仓重量 75kg 与原单 100kg 不一致，回仓单 RW-0003 转入待复核", createdAt: iso(now - DAY + 3 * HOUR) },
      { id: "seed-c1", orderNo: "ORD-9040", driver: "赵师傅", slot: "17:00-19:00", rule: RULES.DUP_RETURN, detail: "订单 ORD-9040 已存在有效回仓单 RW-0001（待取件），新建回仓单被拒绝", createdAt: iso(now - DAY + 2 * HOUR) },
    ],
  };
}
