const POS_API_URL = 'https://script.google.com/macros/s/AKfycbxsQR3z1P7ND5OOFf16PbfeYXpKNUadalDQ5EgnqVGFubbXDFsjXCfuCdPEEQkpQ9F-/exec';
const LOCAL_QUEUE_KEY = 'stationery_pos_sync_queue_v4';
const LAST_SELECTED_USER_KEY = 'stationery_pos_last_user_v1';

const stores = {
  store1: { name: 'One Stop' },
  store2: { name: 'Golden' }
};

let currentStore = null;
let products = [];
let users = [];
let currentSales = [];
let allStoreProducts = [];
let adjustmentItems = [];
let isSyncing = false;

function setStatus(message, type = 'info') {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = message;
  el.className = 'sync-status ' + type;
}

function storeName() {
  return stores[currentStore]?.name || '';
}

function generateId() {
  return 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_QUEUE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveQueue(queue) {
  localStorage.setItem(LOCAL_QUEUE_KEY, JSON.stringify(queue));
  updatePendingBadge();
}

function addToQueue(action, payload) {
  const queue = getQueue();
  queue.push({
    id: generateId(),
    action,
    payload,
    createdAt: new Date().toISOString(),
    status: 'pending'
  });
  saveQueue(queue);
}

function removeFromQueue(id) {
  const queue = getQueue().filter(item => item.id !== id);
  saveQueue(queue);
}

function updatePendingBadge() {
  const el = document.getElementById('pending-count');
  if (!el) return;
  el.textContent = getQueue().length;
}

function parseMoney(value) {
  if (value == null) return 0;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '') return 0;
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (!isFinite(n)) return '0';

  const hasDecimals = Math.round(n * 100) !== Math.round(n) * 100;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2
  }).format(n);
}

function attachMoneyFormatting() {
  document.querySelectorAll('.money-input').forEach(input => {
    input.addEventListener('focus', function () {
      this.value = String(parseMoney(this.value) || '');
    });

    input.addEventListener('blur', function () {
      const n = parseMoney(this.value);
      this.value = this.value.trim() === '' ? '' : formatMoney(n);
      if (['price', 'discount', 'extra'].includes(this.id)) {
        calculateTotal();
      }
    });

    input.addEventListener('input', function () {
      this.value = this.value.replace(/[^\d.,-]/g, '');
      if (['price', 'discount', 'extra'].includes(this.id)) {
        calculateTotal();
      }
    });
  });
}

async function apiRequest(action, data = {}) {
  const readActions = ['health', 'products', 'stock', 'users'];

  try {
    let response;

    if (readActions.includes(action)) {
      const url = new URL(POS_API_URL);
      url.searchParams.set('action', action);

      if (data.store) {
        url.searchParams.set('store', data.store);
      }

      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
    } else {
      const payload = { action, ...data };

      response = await fetch(POS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
    }

    const text = await response.text();

    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error('Server did not return JSON: ' + text);
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

async function processQueue() {
  if (isSyncing) return;

  const queue = getQueue();
  if (!queue.length) {
    setStatus('Ready', 'success');
    return;
  }

  isSyncing = true;

  try {
    setStatus(`Syncing ${queue.length} pending item(s)...`, 'warning');

    for (const job of queue) {
      const result = await apiRequest(job.action, job.payload);

      if (result.ok) {
        removeFromQueue(job.id);
      } else {
        console.error('Queue sync failed:', job, result);
        setStatus(`${getQueue().length} pending. Sync will retry automatically.`, 'error');
        return;
      }
    }

    updatePendingBadge();
    setStatus('All pending data synced successfully', 'success');

    if (currentStore) {
      loadProducts();
    }
  } finally {
    isSyncing = false;
  }
}

function queueAndSync(action, payload, successMessage) {
  addToQueue(action, payload);
  setStatus(successMessage + ' Saved locally.', 'success');
  setTimeout(processQueue, 120);
}

function showSection(id) {
  const sections = ['store-selection', 'pos-container'];
  sections.forEach(sectionId => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    if (sectionId === id) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });
}

async function selectStore(storeId) {
  currentStore = storeId;
  showSection('pos-container');
  document.getElementById('store-name').textContent = stores[storeId].name + ' POS';
  setStatus(`Loading ${storeName()} data...`, 'warning');

  await Promise.all([loadProducts(), loadUsers()]);
  processQueue();
}

async function loadProducts() {
  try {
    const res = await apiRequest('products', { store: storeName() });

    if (!res || !res.ok) {
      throw new Error(res?.error || 'Failed to load products');
    }

    if (!Array.isArray(res.data)) {
      throw new Error('Invalid product feed');
    }

    // FIXED: Properly map the product data with correct field names
    products = res.data.map(p => ({
      id: p.productId || p.id,
      name: p.productName || p.name,
      prices: {
        ct: Number(p.priceCt) || 0,
        dz: Number(p.priceDz) || 0,
        pc: Number(p.pricePc) || Number(p.price) || 0
      },
      stock: Number(p.stock) || 0,
      stockStore1: Number(p.stockOneStop) || Number(p.stock_store1) || 0,
      stockStore2: Number(p.stockGolden) || Number(p.stock_store2) || 0,
      countingUnit: p.countingUnit || p.unit || 'pc'
    }));

    console.log('Loaded products:', products); // Debug log
    
    populateSalesDatalist();
    populateAdjustmentDatalist();
    setStatus(`Loaded ${products.length} products`, 'success');
  } catch (error) {
    console.error('loadProducts error:', error);
    setStatus('Failed to load products: ' + error.message, 'error');
  }
}

async function loadUsers() {
  try {
    const res = await apiRequest('users', { store: storeName() });

    if (!res || !res.ok) {
      throw new Error(res?.error || 'Failed to load users');
    }

    users = Array.isArray(res.data) ? res.data : [];
    populateUserSelects();
  } catch (error) {
    console.error('loadUsers error:', error);
    setStatus('Failed to load users: ' + error.message, 'error');
  }
}

function populateUserSelects() {
  const selects = [
    'sales-submitted-by',
    'adjustment-submitted-by',
    'expense-submitted-by'
  ];

  const remembered = localStorage.getItem(LAST_SELECTED_USER_KEY + '_' + storeName()) || '';

  selects.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;

    select.innerHTML = '<option value="">Select employee</option>';

    users.forEach(user => {
      const option = document.createElement('option');
      option.value = user.username;
      option.textContent = user.username + (user.role ? ` (${user.role})` : '');
      select.appendChild(option);
    });

    if (remembered && users.some(u => u.username === remembered)) {
      select.value = remembered;
    }

    select.onchange = function () {
      if (this.value) {
        localStorage.setItem(LAST_SELECTED_USER_KEY + '_' + storeName(), this.value);
        mirrorSelectedUser(this.value);
      }
    };
  });

  if (remembered) {
    mirrorSelectedUser(remembered);
  }
}

function mirrorSelectedUser(username) {
  ['sales-submitted-by', 'adjustment-submitted-by', 'expense-submitted-by'].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;

    const exists = Array.from(select.options).some(o => o.value === username);
    if (exists && select.value !== username) {
      select.value = username;
    }
  });
}

function populateSalesDatalist() {
  const dl = document.getElementById('item-list');
  if (!dl) return;
  dl.innerHTML = '';

  products.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    dl.appendChild(opt);
  });
}

function populateAdjustmentDatalist() {
  const dl = document.getElementById('adjustment-item-list');
  if (!dl) return;
  dl.innerHTML = '';

  products.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    dl.appendChild(opt);
  });
}

function updateSelectedStockInfo() {
  const itemName = document.getElementById('item')?.value.trim().toLowerCase();
  const box = document.getElementById('selected-stock-info');
  if (!box) return;

  if (!itemName) {
    box.textContent = 'Select an item to view stock';
    return;
  }

  const product = products.find(p => p.name.toLowerCase() === itemName);
  if (!product) {
    box.textContent = 'Product not found in feed';
    return;
  }

  const currentStoreStock = currentStore === 'store1' ? product.stockStore1 : product.stockStore2;
  const otherStoreStock = currentStore === 'store1' ? product.stockStore2 : product.stockStore1;
  const otherStoreName = currentStore === 'store1' ? 'Golden' : 'One Stop';

  box.textContent = `Current stock here: ${formatMoney(currentStoreStock)} | ${otherStoreName}: ${formatMoney(otherStoreStock)}`;
}

function updateAdjustmentStockInfo() {
  const itemName = document.getElementById('adjustment-search')?.value.trim().toLowerCase();
  const box = document.getElementById('adjustment-stock-info');
  if (!box) return;

  if (!itemName) {
    box.textContent = 'Search an item to view stock';
    return;
  }

  const product = products.find(p => p.name.toLowerCase() === itemName);
  if (!product) {
    box.textContent = 'Product not found in feed';
    return;
  }

  const currentStoreStock = currentStore === 'store1' ? product.stockStore1 : product.stockStore2;
  const otherStoreStock = currentStore === 'store1' ? product.stockStore2 : product.stockStore1;
  const otherStoreName = currentStore === 'store1' ? 'Golden' : 'One Stop';

  box.textContent = `Current stock here: ${formatMoney(currentStoreStock)} | ${otherStoreName}: ${formatMoney(otherStoreStock)}`;
}

function updatePrice() {
  const itemName = document.getElementById('item').value.trim().toLowerCase();
  const unit = document.getElementById('unit').value;
  const product = products.find(p => p.name.toLowerCase() === itemName);

  if (product && product.prices) {
    const priceValue = product.prices[unit] || 0;
    document.getElementById('price').value = priceValue > 0 ? formatMoney(priceValue) : '';
  } else {
    document.getElementById('price').value = '';
  }
  
  updateSelectedStockInfo();
  calculateTotal();
}

function calculateTotal() {
  const quantity = parseFloat(document.getElementById('quantity').value) || 0;
  const price = parseMoney(document.getElementById('price').value);
  const discount = parseMoney(document.getElementById('discount').value);
  const extra = parseMoney(document.getElementById('extra').value);
  const total = (quantity * price) - discount + extra;

  document.getElementById('total').value = formatMoney(total);
  return total;
}

function resetForm() {
  document.getElementById('sale-form').reset();
  document.getElementById('price').value = '';
  document.getElementById('discount').value = '0';
  document.getElementById('extra').value = '0';
  document.getElementById('total').value = '';

  const box = document.getElementById('selected-stock-info');
  if (box) box.textContent = 'Select an item to view stock';
}

function updateSalesTable() {
  const tbody = document.querySelector('#sales-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!currentSales.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">No items added yet</td></tr>';
  } else {
    let grandTotal = 0;

    currentSales.forEach((sale, index) => {
      grandTotal += sale.total;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td>${sale.item}</td>
        <td>${sale.unit}</td>
        <td>${sale.quantity}</td>
        <td>${formatMoney(sale.price)}</td>
        <td>${formatMoney(sale.discount)}</td>
        <td>${formatMoney(sale.extra)}</td>
        <td>${formatMoney(sale.total)}</td>
        <td>${sale.paymentMethod}</td>
        <td><button class="btn-mini" onclick="removeSale(${index})">×</button></td>
      `;
      tbody.appendChild(tr);
    });

    const totalRow = document.createElement('tr');
    totalRow.innerHTML = `
      <td colspan="7" style="text-align:right;"><strong>Grand Total</strong></td>
      <td><strong>${formatMoney(grandTotal)}</strong></td>
      <td colspan="2"></td>
    `;
    tbody.appendChild(totalRow);
  }

  const submitBtn = document.getElementById('submit-all-btn');
  const clearBtn = document.getElementById('clear-all-btn');

  if (submitBtn) submitBtn.classList.toggle('hidden', !currentSales.length);
  if (clearBtn) clearBtn.classList.toggle('hidden', !currentSales.length);
}

function removeSale(index) {
  currentSales.splice(index, 1);
  updateSalesTable();
  setStatus('Item removed from current sale', 'warning');
}

function clearAllSales() {
  currentSales = [];
  updateSalesTable();
  setStatus('Current sale cleared', 'warning');
}

function getSubmitIdentity(type) {
  const selectId = {
    sales: 'sales-submitted-by',
    adjustments: 'adjustment-submitted-by',
    cashout: 'expense-submitted-by'
  }[type];

  const pinId = {
    sales: 'sales-pin',
    adjustments: 'adjustment-pin',
    cashout: 'expense-pin'
  }[type];

  const submittedBy = document.getElementById(selectId)?.value || '';
  const userPin = document.getElementById(pinId)?.value || '';

  return { submittedBy, userPin, pinId };
}

function clearPin(pinId) {
  const el = document.getElementById(pinId);
  if (el) el.value = '';
}

function submitAllSales() {
  if (!currentSales.length) {
    setStatus('No items to submit', 'error');
    return;
  }

  const { submittedBy, userPin, pinId } = getSubmitIdentity('sales');
  if (!submittedBy || !userPin) {
    setStatus('Select employee and enter PIN before submitting sales', 'error');
    return;
  }

  const payload = {
    store: storeName(),
    submittedBy,
    userPin,
    items: currentSales,
    timestamp: new Date().toISOString()
  };

  const count = currentSales.length;
  currentSales = [];
  updateSalesTable();
  clearPin(pinId);

  queueAndSync('sales', payload, `${count} sales line(s) queued.`);
}

async function showStockLevels() {
  try {
    const res = await apiRequest('stock', {});
    if (!res.ok) {
      setStatus('Could not load stock', 'error');
      return;
    }

    allStoreProducts = res.data || [];
    populateStockTable(allStoreProducts);
    document.getElementById('stock-modal').style.display = 'flex';

    const searchInput = document.getElementById('stock-search');
    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = function () {
        const term = this.value.toLowerCase().trim();
        const filtered = allStoreProducts.filter(p =>
          !term || String(p.productName).toLowerCase().includes(term)
        );
        populateStockTable(filtered);
      };
    }
  } catch (error) {
    console.error(error);
    setStatus('Failed to load stock levels', 'error');
  }
}

function hideStockLevels() {
  document.getElementById('stock-modal').style.display = 'none';
}

function populateStockTable(list) {
  const tbody = document.getElementById('stock-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  let outCount = 0;
  let lowCount = 0;

  list.forEach(p => {
    const one = Number(p.stockOneStop) || 0;
    const two = Number(p.stockGolden) || 0;
    let label = 'OK';
    let cls = 'status-ok';

    if (one <= 0 && two <= 0) {
      label = 'OUT';
      cls = 'status-out';
      outCount++;
    } else if (one <= 5 || two <= 5) {
      label = 'LOW';
      cls = 'status-low';
      lowCount++;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.productName}</td>
      <td>${formatMoney(one)}</td>
      <td>${formatMoney(two)}</td>
      <td class="${cls}">${label}</td>
    `;
    tbody.appendChild(tr);
  });

  const summary = document.getElementById('stock-summary');
  if (summary) {
    summary.textContent = `Products: ${list.length} | Out: ${outCount} | Low: ${lowCount}`;
  }
}

function showStockAdjustment() {
  adjustmentItems = [];
  document.getElementById('adjustment-store-name').textContent = storeName();
  updateAdjustmentTable();
  document.getElementById('stock-adjustment-modal').style.display = 'flex';

  const input = document.getElementById('adjustment-search');
  const info = document.getElementById('adjustment-stock-info');

  if (input) {
    input.value = '';
    input.focus();
  }

  if (info) {
    info.textContent = 'Search an item to view stock';
  }
}

function hideStockAdjustment() {
  document.getElementById('stock-adjustment-modal').style.display = 'none';
}

function addItemToAdjustment() {
  const name = document.getElementById('adjustment-search').value.trim();
  const p = products.find(x => x.name.toLowerCase() === name.toLowerCase());

  if (!p) {
    setStatus('Product not found', 'error');
    return;
  }

  if (adjustmentItems.some(x => x.name === p.name)) {
    setStatus('Item already added', 'warning');
    return;
  }

  adjustmentItems.push({
    name: p.name,
    unit: 'pc',
    adjustmentType: 'add',
    quantity: 0
  });

  document.getElementById('adjustment-search').value = '';
  updateAdjustmentTable();
  setStatus('Item added to stock adjustment', 'success');
}
