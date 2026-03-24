async function apiRequest(action, data = {}) {
  console.log(`API Request: ${action}`, data);

  try {
    let response;
    const url = new URL(POS_API_URL);

    const getActions = ['health', 'products', 'stock', 'users'];
    const postActions = ['sales', 'adjustments', 'cashout'];

    if (getActions.includes(action)) {
      url.searchParams.set('action', action);

      if (data.store) {
        url.searchParams.set('store', data.store);
      }

      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });

    } else if (postActions.includes(action)) {
      const payload = { action, ...data };

      response = await fetch(POS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });

    } else {
      const payload = { action, ...data };

      response = await fetch(POS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
    }

    const text = await response.text();
    console.log(`API Response (${action}):`, text);

    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      console.error('JSON Parse Error:', parseErr);
      throw new Error(`Server did not return valid JSON: ${text}`);
    }

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    return result;

  } catch (error) {
    console.error('API Request Error:', error);
    return { ok: false, error: error.message || String(error) };
  }
}
