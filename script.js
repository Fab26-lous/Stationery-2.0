const POS_API_URL = 'https://script.google.com/macros/s/AKfycbxsQR3z1P7ND5OOFf16PbfeYXpKNUadalDQ5EgnqVGFubbXDFsjXCfuCdPEEQkpQ9F-/exec';

const stores = {
  store1: { name: 'One Stop', users: { Cashier: 'Glam2025' } },
  store2: { name: 'Golden', users: { Cashier2: 'Glam2025' } }
};

const LOCAL_QUEUE_KEY = 'stationery_pos_sync_queue_v3';

let currentStore = null;
let currentUser = null;
let products = [];
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

async function apiRequest(action, data = {}) {
  const readActions = ['health', 'products', 'stock'];

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
        headers: {
          'Accept': 'application/json'
        }
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
  ['login-container', 'store-selection', 'pos-container'].forEach(sectionId => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    if (sectionId === id) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
}

function checkLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const error = document.getElementById('login-error');
  let validStore = null;

  error.textContent = '';

  for (const storeId in stores) {
    if (stores[storeId].users[username] === password) {
      validStore = storeId;
      break;
    }
  }

  if (!validStore) {
    error.textContent = 'Invalid username or password';
    setStatus('Login failed', 'error');
    return;
  }

  currentStore = validStore;
  currentUser = username;
  showSection('store-selection');
  setStatus('Login successful. Select your store.', 'success');
}

function selectStore(storeId) {
  if (storeId !== currentStore) {
    setStatus('You are not authorized for this store', 'error');
    return;
  }

  showSection('pos-container');
  document.getElementById('store-name').textContent = stores[storeId].name + ' POS';
  loadProducts();
  processQueue();
}

async function loadProducts() {
  try {
    setStatus('Loading products...', 'warning');

    const res = await apiRequest('products', { store: storeName() });

    if (!res || !res.ok) {
      throw new Error(res?.error || 'Failed to load products');
    }

    if (!Array.isArray(res.data)) {
      throw new Error('Invalid product feed');
    }

    products = res.data.map(p => ({
      id: p.productId,
      name: p.productName,
      prices: {
        ct: Number(p.priceCt) || 0,
        dz: Number(p.priceDz) || 0,
        pc: Number(p.pricePc) || 0
      },
      stock: Number(p.stock) || 0,
      stockStore1: Number(p.stockOneStop) || 0,
      stockStore2: Number(p.stockGolden) || 0,
      countingUnit: p.countingUnit || 'pc'
    }));

    populateSalesDatalist();
    populateAdjustmentDatalist();
    setStatus(`Loaded ${products.length} products`, 'success');
  } catch (error) {
    console.error('loadProducts error:', error);
    setStatus('Failed to load products: ' + error.message, 'error');
  }
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

  box.textContent = `Current stock here: ${currentStoreStock} | ${otherStoreName}: ${otherStoreStock}`;
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

  box.textContent = `Current stock here: ${currentStoreStock} | ${otherStoreName}: ${otherStoreStock}`;
}

function updatePrice() {
  const itemName = document.getElementById('item').value.trim().toLowerCase();
  const unit = document.getElementById('unit').value;
  const product = products.find(p => p.name.toLowerCase() === itemName);

  document.getElementById('price').value = product ? (product.prices[unit] || 0) : '';
  updateSelectedStockInfo();
  calculateTotal();
}

function calculateTotal() {
  const quantity = parseFloat(document.getElementById('quantity').value) || 0;
  const price = parseFloat(document.getElementById('price').value) || 0;
  const discount = parseFloat(document.getElementById('discount').value) || 0;
  const extra = parseFloat(document.getElementById('extra').value) || 0;
  const total = (quantity * price) - discount + extra;
  document.getElementById('total').value = total.toFixed(2);
  return total;
}

function resetForm() {
  document.getElementById('sale-form').reset();
  document.getElementById('price').value = '';
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
        <td>${sale.price.toFixed(2)}</td>
        <td>${sale.discount.toFixed(2)}</td>
        <td>${sale.extra.toFixed(2)}</td>
        <td>${sale.total.toFixed(2)}</td>
        <td>${sale.paymentMethod}</td>
        <td><button class="btn-mini" onclick="removeSale(${index})">×</button></td>
      `;
      tbody.appendChild(tr);
    });

    const totalRow = document.createElement('tr');
    totalRow.innerHTML = `
      <td colspan="7" style="text-align:right;"><strong>Grand Total</strong></td>
      <td><strong>${grandTotal.toFixed(2)}</strong></td>
      <td colspan="2"></td>
    `;
    tbody.appendChild(totalRow);
  }

  const submitBtn = document.getElementById('submit-all-btn');
  const clearBtn = document.getElementById('clear-all-btn');

  if (submitBtn) {
    submitBtn.classList.toggle('hidden', !currentSales.length);
  }

  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !currentSales.length);
  }
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

function submitAllSales() {
  if (!currentSales.length) {
    setStatus('No items to submit', 'error');
    return;
  }

  const payload = {
    store: storeName(),
    cashier: currentUser,
    items: currentSales,
    timestamp: new Date().toISOString()
  };

  const count = currentSales.length;
  currentSales = [];
  updateSalesTable();

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
      <td>${one}</td>
      <td>${two}</td>
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

function updateAdjustmentTable() {
  const tbody = document.getElementById('adjustment-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!adjustmentItems.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No items added yet</td></tr>';
  } else {
    adjustmentItems.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.name}</td>
        <td>
          <select onchange="adjustmentItems[${index}].unit=this.value">
            <option value="pc" ${item.unit === 'pc' ? 'selected' : ''}>pc</option>
            <option value="dz" ${item.unit === 'dz' ? 'selected' : ''}>dz</option>
            <option value="ct" ${item.unit === 'ct' ? 'selected' : ''}>ct</option>
          </select>
        </td>
        <td>
          <select onchange="adjustmentItems[${index}].adjustmentType=this.value">
            <option value="add" ${item.adjustmentType === 'add' ? 'selected' : ''}>Add</option>
            <option value="remove" ${item.adjustmentType === 'remove' ? 'selected' : ''}>Remove</option>
            <option value="set" ${item.adjustmentType === 'set' ? 'selected' : ''}>Set</option>
          </select>
        </td>
        <td>
          <input type="number" step="any" min="0" value="${item.quantity}" onchange="adjustmentItems[${index}].quantity=Number(this.value||0)">
        </td>
        <td>
          <button class="btn-mini" onclick="removeAdjustmentItem(${index})">Remove</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  const summary = document.getElementById('adjustment-summary');
  if (summary) {
    summary.textContent = `Items to adjust: ${adjustmentItems.length}`;
  }
}

function removeAdjustmentItem(index) {
  adjustmentItems.splice(index, 1);
  updateAdjustmentTable();
  setStatus('Adjustment item removed', 'warning');
}

function clearAdjustments() {
  adjustmentItems = [];
  updateAdjustmentTable();
  setStatus('Adjustment list cleared', 'warning');
}

function submitStockAdjustment() {
  if (!adjustmentItems.length) {
    setStatus('No adjustment items', 'error');
    return;
  }

  const payload = {
    store: storeName(),
    items: adjustmentItems,
    timestamp: new Date().toISOString()
  };

  const count = adjustmentItems.length;
  adjustmentItems = [];
  updateAdjustmentTable();
  hideStockAdjustment();

  queueAndSync('adjustments', payload, `${count} adjustment(s) queued.`);
}

function showExpenseModal() {
  document.getElementById('expense-modal').style.display = 'flex';
}

function hideExpenseModal() {
  document.getElementById('expense-modal').style.display = 'none';
}

function submitExpense() {
  const payload = {
    store: storeName(),
    cashoutType: 'Operating_Expense',
    category: document.getElementById('expense-category').value.trim(),
    description: document.getElementById('expense-description').value.trim(),
    amount: Number(document.getElementById('expense-amount').value || 0),
    paymentMethod: document.getElementById('expense-payment').value,
    timestamp: new Date().toISOString()
  };

  if (!payload.category || !payload.amount) {
    setStatus('Expense category and amount are required', 'error');
    return;
  }

  document.getElementById('expense-category').value = '';
  document.getElementById('expense-description').value = '';
  document.getElementById('expense-amount').value = '';
  document.getElementById('expense-payment').value = 'Cash';

  hideExpenseModal();
  queueAndSync('cashout', payload, 'Expense queued.');
}

document.addEventListener('DOMContentLoaded', function () {
  showSection('login-container');
  updatePendingBadge();

  ['quantity', 'price', 'discount', 'extra'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.addEventListener('input', calculateTotal);
  });

  const itemInput = document.getElementById('item');
  if (itemInput) itemInput.addEventListener('input', updatePrice);

  const unitSelect = document.getElementById('unit');
  if (unitSelect) unitSelect.addEventListener('change', updatePrice);

  const adjustmentInput = document.getElementById('adjustment-search');
  if (adjustmentInput) adjustmentInput.addEventListener('input', updateAdjustmentStockInfo);

  const saleForm = document.getElementById('sale-form');
  if (saleForm) {
    saleForm.addEventListener('submit', function (e) {
      e.preventDefault();

      const item = document.getElementById('item').value.trim();
      if (!item) {
        setStatus('Please select an item', 'error');
        return;
      }

      const sale = {
        item,
        unit: document.getElementById('unit').value,
        quantity: parseFloat(document.getElementById('quantity').value) || 0,
        price: parseFloat(document.getElementById('price').value) || 0,
        discount: parseFloat(document.getElementById('discount').value) || 0,
        extra: parseFloat(document.getElementById('extra').value) || 0,
        paymentMethod: document.getElementById('payment-method').value,
        total: calculateTotal(),
        timestamp: new Date().toISOString()
      };

      currentSales.push(sale);
      updateSalesTable();
      resetForm();
      setStatus('Item added to current sale', 'success');
    });
  }

  setInterval(processQueue, 8000);
  window.addEventListener('online', processQueue);
});

window.checkLogin = checkLogin;
window.selectStore = selectStore;
window.removeSale = removeSale;
window.clearAllSales = clearAllSales;
window.submitAllSales = submitAllSales;
window.showStockLevels = showStockLevels;
window.hideStockLevels = hideStockLevels;
window.showStockAdjustment = showStockAdjustment;
window.hideStockAdjustment = hideStockAdjustment;
window.addItemToAdjustment = addItemToAdjustment;
window.removeAdjustmentItem = removeAdjustmentItem;
window.clearAdjustments = clearAdjustments;
window.submitStockAdjustment = submitStockAdjustment;
window.showExpenseModal = showExpenseModal;
window.hideExpenseModal = hideExpenseModal;
window.submitExpense = submitExpense;
