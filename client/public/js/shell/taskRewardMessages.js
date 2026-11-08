// What the "well done" card says (pure: no DOM, no network; unit-tested). The wording is chosen by the kind of work that was finished, so a
// payment feels different from a visit, and by how much the person has done today / this week, so the card means something.
// Returns i18n keys + numbers; the card (taskReward.js) turns them into text.

const KIND_KEYS = { collect_debt: "reward_kind_debt", make_order: "reward_kind_order", visit_customer: "reward_kind_visit", check_products: "reward_kind_check" };

export function rewardKindKey(task) {
  if (task?.auto_kind === "debt_collection") return "reward_kind_debt";
  if (task?.auto_kind === "reorder_followup") return "reward_kind_order";
  return KIND_KEYS[task?.task_kind] ?? "reward_kind_default";
}

// rewards: the finished tasks (newest first); stats: { done_today, done_week, open_left, overdue_left } or null.
export function rewardCard(rewards, stats) {
  const n = rewards.length;
  const first = rewards[0];
  const lines = [];
  if (stats?.done_week > 0) lines.push({ key: "reward_week", n: stats.done_week });
  if (stats && stats.open_left === 0) lines.push({ key: "reward_all_clear" });
  else if (stats?.overdue_left > 0) lines.push({ key: "reward_overdue", n: stats.overdue_left });
  else if (stats?.open_left > 0) lines.push({ key: "reward_left", n: stats.open_left });
  // a bigger moment: the last open task, a streak of 3+ today, or several tasks at once
  const big = n > 1 || (stats && stats.open_left === 0) || (stats?.done_today ?? 0) >= 3;
  return {
    titleKey: n > 1 ? "reward_title_many" : `reward_title_${1 + ((first?.id ?? 0) % 3)}`,
    n,
    kindKey: n > 1 ? null : rewardKindKey(first),
    customer: n > 1 ? null : first?.customer_name || null,
    names: n > 1 ? rewards.slice(0, 3).map((r) => r.customer_name || r.title) : [],
    more: Math.max(0, n - 3),
    lines,
    big,
  };
}
