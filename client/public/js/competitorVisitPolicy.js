(function () {
  if (window.__kadCompetitorPolicyInstalled) return;
  window.__kadCompetitorPolicyInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const competitorIds = new Set();
  const competitorNames = new Set();
  window.__kadCompetitorIds = competitorIds;
  window.__kadCompetitorNames = competitorNames;

  function asUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, location.origin);
      if (input instanceof Request) return new URL(input.url, location.origin);
      return null;
    } catch {
      return null;
    }
  }

  function rememberCustomers(payload) {
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object" ? [payload] : [];
    for (const customer of rows) {
      if (customer?.customer_tier !== "competitor") continue;
      if (Number.isInteger(Number(customer.id))) competitorIds.add(Number(customer.id));
      if (typeof customer.name === "string" && customer.name.trim()) competitorNames.add(customer.name.trim());
    }
  }

  function normalizeCustomerVisitState(payload, url) {
    if (!payload) return payload;
    const rows = Array.isArray(payload) ? payload : [payload];
    rememberCustomers(rows);

    const filtered = rows
      .filter((customer) => {
        if (customer?.customer_tier !== "competitor") return true;
        const visitedFilter = url.searchParams.get("visited");
        // Competitors do not belong in operational queues such as Overdue or
        // Not visited because no recurring visit is required for them.
        return visitedFilter !== "overdue" && visitedFilter !== "not_visited";
      })
      .map((customer) =>
        customer?.customer_tier === "competitor"
          ? { ...customer, overdue: false, visit_required: false }
          : customer
      );

    return Array.isArray(payload) ? filtered : filtered[0] ?? null;
  }

  function sanitizePlan(plan) {
    if (!plan || !Array.isArray(plan.customer_ids) || !competitorIds.size) return plan;
    return { ...plan, customer_ids: plan.customer_ids.filter((id) => !competitorIds.has(Number(id))) };
  }

  async function jsonResponse(response, payload) {
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  window.fetch = async function kadFetch(input, init) {
    const url = asUrl(input);
    let nextInit = init;

    if (url && /\/api\/visit-plans(?:\/|$)/.test(url.pathname) && init?.body && competitorIds.size) {
      try {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.customer_ids)) {
          body.customer_ids = body.customer_ids.filter((id) => !competitorIds.has(Number(id)));
          nextInit = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // Non-JSON request body: leave untouched.
      }
    }

    const response = await originalFetch(input, nextInit);
    if (!url || !response.ok) return response;

    const isCustomers = /\/api\/customers(?:\/\d+)?$/.test(url.pathname);
    const isVisitPlan = /\/api\/visit-plans(?:\/mine)?$/.test(url.pathname) && (nextInit?.method ?? "GET").toUpperCase() === "GET";
    if (!isCustomers && !isVisitPlan) return response;

    try {
      const payload = await response.clone().json();
      if (isCustomers) return jsonResponse(response, normalizeCustomerVisitState(payload, url));
      if (isVisitPlan) return jsonResponse(response, sanitizePlan(payload));
    } catch {
      return response;
    }
    return response;
  };
})();
