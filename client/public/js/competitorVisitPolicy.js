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
        return visitedFilter !== "overdue" && visitedFilter !== "not_visited";
      })
      .map((customer) =>
        customer?.customer_tier === "competitor"
          ? { ...customer, overdue: false, visit_required: false }
          : customer
      );

    return Array.isArray(payload) ? filtered : filtered[0] ?? null;
  }

  function sanitizePlanPayload(value) {
    if (!value || !competitorIds.size) return value;
    if (Array.isArray(value)) return value.map(sanitizePlanPayload);
    if (typeof value !== "object") return value;

    const next = { ...value };
    if (Array.isArray(next.customer_ids)) {
      next.customer_ids = next.customer_ids.filter((id) => !competitorIds.has(Number(id)));
    }
    if (Array.isArray(next.days)) next.days = next.days.map(sanitizePlanPayload);
    return next;
  }

  function jsonResponse(response, payload) {
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  window.fetch = async function kadFetch(input, init) {
    const url = asUrl(input);
    let nextInit = init;

    if (url && url.pathname.startsWith("/api/visit-plans") && init?.body && competitorIds.size) {
      try {
        const body = JSON.parse(init.body);
        const sanitized = sanitizePlanPayload(body);
        nextInit = { ...init, body: JSON.stringify(sanitized) };
      } catch {
        // Non-JSON request body: leave untouched.
      }
    }

    const response = await originalFetch(input, nextInit);
    if (!url || !response.ok) return response;

    const method = (nextInit?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const isCustomers = /\/api\/customers(?:\/\d+)?$/.test(url.pathname);
    const isVisitPlan = url.pathname.startsWith("/api/visit-plans") && method === "GET";
    if (!isCustomers && !isVisitPlan) return response;

    try {
      const payload = await response.clone().json();
      if (isCustomers) return jsonResponse(response, normalizeCustomerVisitState(payload, url));
      if (isVisitPlan) return jsonResponse(response, sanitizePlanPayload(payload));
    } catch {
      return response;
    }
    return response;
  };
})();
