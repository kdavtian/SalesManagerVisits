// "Separate plans": one person (e.g. Artak) can own customers of several sales channels (SM Davtashen AND SM B2B).
// The recurring plan is still stored as ONE rule per person and weekday (so "today's visits", Vaghinak, the map and the
// customer cards keep reading one list), but the planners see and edit it as separate PLANS: the "main" plan (everything
// that is not listed below) and one plan per channel listed here. Editing one plan never touches the other's customers.
export const SEPARATE_PLAN_CHANNELS = ["SM B2B"];
export const MAIN_SCOPE = "";

// The plan a customer belongs to: its own channel when that channel is planned separately, otherwise the main plan.
export const scopeOfChannel = (channel) => (SEPARATE_PLAN_CHANNELS.includes(channel) ? channel : MAIN_SCOPE);

// null = not a valid plan scope.
export function parseScope(raw) {
  const s = String(raw ?? "").trim();
  if (s === MAIN_SCOPE) return MAIN_SCOPE;
  return SEPARATE_PLAN_CHANNELS.includes(s) ? s : null;
}

// customer id -> sales channel, for every customer (small table: one cheap read).
export async function loadChannelMap(db) {
  const { rows } = await db.query("SELECT id, sales_channel FROM customers");
  return new Map(rows.map((r) => [r.id, r.sales_channel]));
}

export const inScope = (customerId, scope, channelOf) => scopeOfChannel(channelOf.get(customerId)) === scope;

// New content of a rule when one plan's customers are saved: the other plans' customers stay exactly as they are, the
// submitted ids replace this plan's (ids that do not belong to this plan are ignored).
export function mergeScopeIds({ existing, submitted, scope, channelOf }) {
  const keep = existing.filter((id) => channelOf.has(id) && !inScope(id, scope, channelOf));
  const mine = submitted.filter((id) => inScope(id, scope, channelOf));
  return [...new Set([...keep, ...mine])];
}

// The plans a person has: always the main plan, plus a separate plan for every special channel they own customers in.
export function scopesFor(customerIds, channelOf) {
  const out = [MAIN_SCOPE];
  for (const channel of SEPARATE_PLAN_CHANNELS) {
    if (customerIds.some((id) => channelOf.get(id) === channel)) out.push(channel);
  }
  return out;
}
