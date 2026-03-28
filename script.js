const POS_API_URL = 'https://script.google.com/macros/s/AKfycbyLmOguMkmKEvXvbCBR_7H5ztqkIs_jqafcCtjOB1aMKO7SLpVa4KDjbSAhNtVsf5Ej/exec'; // Replace with your URL
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

// Status display
function setStatus(message, type = 'info') {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = message;
  el.className = 'sync-status ' + type;
  console.log(`[Status] ${type}: ${message}`);
}

function storeName() {
  return stores[currentStore]?.name || '';
}

function generateId() {
  return 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Queue management
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

// Money formatting
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
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(n);
}

function attachMoneyFormatting() {
  document.querySelectorAll('.money-input').forEach(input => {
    input.removeEventListener('blur', handleMoneyBlur);
    input.removeEventListener('focus', handleMoneyFocus);
    input.addEventListener('focus', handleMoneyFocus);
    input.addEventListener('blur', handleMoneyBlur);
  });
}

function handleMoneyFocus() {
  this.value = String(parseMoney(this.value) || '');
}

function handleMoneyBlur() {
  const n = parseMoney(this.value);
  this.value = this.value.trim() === '' ? '' : formatMoney(n);
  if (['price', 'discount', 'extra', 'expense-amount'].includes(this.id)) {
    if (this.id !== 'expense-amount') {
      calculateTotal();
    }
  }
}

// JSONP for GET requests (no CORS)
function jsonpRequest(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const callbackName = `jsonp_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${separator}callback=${callbackName}`;
    
    const script = document.createElement('script');
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP request timeout'));
    }, timeout);
    
    window[callbackName] = function(data) {
      cleanup();
      resolve(data);
    };
    
    function cleanup() {
      clearTimeout(timeoutId);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    
    script.src = fullUrl;
    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP request failed'));
    };
    
    document.head.appendChild(script);
  });
}

// Iframe for POST requests (bypasses CORS)
function iframePostRequest(url, data, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const iframeId = `iframe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const iframe = document.createElement('iframe');
    iframe.name = iframeId;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    form.target = iframeId;
    form.style.display = 'none';

    const addField = (name, value) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = typeof value === 'object' ? JSON.stringify(value) : String(value);
      form.appendChild(input);
    };

    Object.keys(data).forEach(key => addField(key, data[key]));
    document.body.appendChild(form);

    const cleanup = () => {
      if (form.parentNode) form.parentNode.removeChild(form);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Request timed out'));
    }, timeout);

    iframe.onload = () => {
      try {
        clearTimeout(timer);

        let text = '';
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          text = (doc.body && doc.body.innerText ? doc.body.innerText : '').trim();
        } catch (_) {
          cleanup();
          resolve({ ok: true, message: 'Submitted, but response could not be read' });
          return;
        }

        cleanup();

        if (!text) {
          reject(new Error('Empty server response'));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          reject(new Error('Invalid server response: ' + text));
          return;
        }

        resolve(parsed);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    iframe.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Submission failed'));
    };

    form.submit();
  });
}

// Main API request function
async function apiRequest(action, data = {}) {
  console.log(`API Request: ${action}`, data);
  
  try {
    // GET actions - use JSONP
    if (['products', 'stock', 'users', 'health'].includes(action)) {
      let url = `${POS_API_URL}?action=${action}`;
      if (data.store) {
        url += `&store=${data.store}`;
      }
      url += `&_=${Date.now()}`;
      
      const result = await jsonpRequest(url);
      console.log(`JSONP Response (${action}):`, result);
      return result;
    }
    
    // POST actions - use iframe
    if (['sales', 'adjustments', 'cashout'].includes(action)) {
      const payload = { action, ...data };
      const result = await iframePostRequest(POS_API_URL, payload);
      return result;
    }
    
    return { ok: false, error: 'Unknown action' };
    
  } catch (error) {
    console.error('API Request Error:', error);
    setStatus(`API Error: ${error.message}`, 'error');
    return { ok: false, error: error.message };
  }
}

// Queue processing
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
      console.log(`Processing queue item: ${job.action}`);
      const result = await apiRequest(job.action, job.payload);
      
      if (result && result.ok) {
        removeFromQueue(job.id);
        console.log(`Successfully synced: ${job.action}`);
      } else {
        console.error('Queue sync failed:', job, result);
        setStatus(`${getQueue().length} pending. Sync will retry.`, 'error');
        return;
      }
    }
    
    updatePendingBadge();
    setStatus('All pending data synced successfully', 'success');
    
    if (currentStore) {
      loadProducts();
      loadUsers();
    }
  } catch (error) {
    console.error('Queue processing error:', error);
    setStatus('Sync failed, will retry', 'error');
  } finally {
    isSyncing = false;
  }
}

function queueAndSync(action, payload, successMessage) {
  addToQueue(action, payload);
  setStatus(successMessage + ' Saved locally. Will sync when online.', 'success');
  setTimeout(processQueue, 3000);
}

function showSection(id) {
  const sections = ['store-selection', 'pos-container'];
  sections.forEach(sectionId => {
    const el = document.getElementById(sectionId);
    if (el) el.classList.toggle('hidden', sectionId !== id);
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

async function loadUsers() {
  try {
    console.log(`Loading users for store: ${storeName()}`);
    setStatus('Loading users...', 'warning');
    
    const res = await apiRequest('users', { store: currentStore });
    
    if (res && res.ok && Array.isArray(res.data)) {
      users = res.data;
      console.log(`Loaded ${users.length} users`);
    } else {
      users = [];
      console.warn('No users data');
    }
    
    populateUserSelects();
    setStatus(users.length ? `Loaded ${users.length} user(s)` : 'No users found', 
              users.length ? 'success' : 'warning');
    
  } catch (error) {
    console.error('loadUsers error:', error);
    users = [];
    populateUserSelects();
    setStatus('Error loading users', 'error');
  }
}

async function loadProducts() {
  try {
    console.log(`Loading products for store: ${storeName()}`);
    setStatus('Loading products...', 'warning');
    
    const res = await apiRequest('products', { store: currentStore });
    
    if (!res || !res.ok || !Array.isArray(res.data) || res.data.length === 0) {
      console.log('No products from API, using demo');
      loadDemoProducts();
      return;
    }
    
    products = res.data.map((p, index) => ({
      id: p.productId || index,
      name: p.productName,
      prices: {
        ct: Number(p.priceCt) || 0,
        dz: Number(p.priceDz) || 0,
        pc: Number(p.pricePc) || 0
      },
      stockStore1: Number(p.stockOneStop) || 0,
      stockStore2: Number(p.stockGolden) || 0,
      countingUnit: p.countingUnit || 'pc'
    }));
    
    console.log(`Loaded ${products.length} products`);
    populateSalesDatalist();
    populateAdjustmentDatalist();
    setStatus(`Loaded ${products.length} products`, 'success');
    
  } catch (error) {
    console.error('loadProducts error:', error);
    loadDemoProducts();
  }
}

function loadDemoProducts() {
  products = [
    { id: '1', name: 'Notebook A4', prices: { ct: 5000, dz: 48000, pc: 550 }, stockStore1: 45, stockStore2: 55, countingUnit: 'pc' },
    { id: '2', name: 'Pen Blue', prices: { ct: 2500, dz: 24000, pc: 250 }, stockStore1: 120, stockStore2: 80, countingUnit: 'pc' },
    { id: '3', name: 'Eraser', prices: { ct: 1000, dz: 9000, pc: 100 }, stockStore1: 90, stockStore2: 60, countingUnit: 'pc' }
  ];
  setStatus('Using DEMO products (API unavailable)', 'warning');
  populateSalesDatalist();
  populateAdjustmentDatalist();
}

function populateUserSelects() {
  const selectIds = ['sales-submitted-by', 'adjustment-submitted-by', 'expense-submitted-by'];
  const remembered = localStorage.getItem(LAST_SELECTED_USER_KEY + '_' + storeName()) || '';
  
  selectIds.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    
    select.innerHTML = '<option value="">Select employee</option>';
    users.forEach(user => {
      const option = document.createElement('option');
      option.value = user.username;
      option.textContent = user.role ? `${user.username} (${user.role})` : user.username;
      select.appendChild(option);
    });
    
    if (remembered && users.some(u => u.username === remembered)) {
      select.value = remembered;
    }
    
    select.onchange = function() {
      const selectedUser = this.value || '';
      if (selectedUser) {
        localStorage.setItem(LAST_SELECTED_USER_KEY + '_' + storeName(), selectedUser);
        mirrorSelectedUser(selectedUser);
      }
    };
  });
  
  if (remembered && users.some(u => u.username === remembered)) {
    mirrorSelectedUser(remembered);
  }
}

function mirrorSelectedUser(username) {
  ['sales-submitted-by', 'adjustment-submitted-by', 'expense-submitted-by'].forEach(id => {
    const select = document.getElementById(id);
    if (select && Array.from(select.options).some(o => o.value === username)) {
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
    box.textContent = 'Product not found';
    return;
  }
  
  const currentStock = currentStore === 'store1' ? product.stockStore1 : product.stockStore2;
  const otherStock = currentStore === 'store1' ? product.stockStore2 : product.stockStore1;
  const otherName = currentStore === 'store1' ? 'Golden' : 'One Stop';
  
  box.textContent = `Current stock: ${formatMoney(currentStock)} | ${otherName}: ${formatMoney(otherStock)}`;
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
    box.textContent = 'Product not found';
    return;
  }
  
  const currentStock = currentStore === 'store1' ? product.stockStore1 : product.stockStore2;
  const otherStock = currentStore === 'store1' ? product.stockStore2 : product.stockStore1;
  const otherName = currentStore === 'store1' ? 'Golden' : 'One Stop';
  
  box.textContent = `Current stock: ${formatMoney(currentStock)} | ${otherName}: ${formatMoney(otherStock)}`;
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
  const form = document.getElementById('sale-form');
  if (form) form.reset();
  document.getElementById('price').value = '';
  document.getElementById('discount').value = '0';
  document.getElementById('extra').value = '0';
  document.getElementById('total').value = '';
  document.getElementById('quantity').value = '';
  const box = document.getElementById('selected-stock-info');
  if (box) box.textContent = 'Select an item to view stock';
}

function addToSale() {
  const item = document.getElementById('item').value.trim();
  const unit = document.getElementById('unit').value;
  const quantity = parseFloat(document.getElementById('quantity').value);
  const price = parseMoney(document.getElementById('price').value);
  const discount = parseMoney(document.getElementById('discount').value);
  const extra = parseMoney(document.getElementById('extra').value);
  const paymentMethod = document.getElementById('payment-method').value;
  const total = (quantity * price) - discount + extra;
  
  if (!item) { setStatus('Please select an item', 'error'); return; }
  if (!quantity || quantity <= 0) { setStatus('Please enter a valid quantity', 'error'); return; }
  if (!price || price <= 0) { setStatus('Please enter a valid price', 'error'); return; }
  
  currentSales.push({ item, unit, quantity, price, discount, extra, total, paymentMethod });
  updateSalesTable();
  resetForm();
  setStatus(`Added ${quantity} ${unit} of ${item}`, 'success');
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
    totalRow.innerHTML = `<td colspan="7" style="text-align:right;"><strong>Grand Total</strong></td><td><strong>${formatMoney(grandTotal)}</strong></td><td colspan="2"></td>`;
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
  setStatus('Item removed', 'warning');
}

function clearAllSales() {
  currentSales = [];
  updateSalesTable();
  setStatus('Current sale cleared', 'warning');
}

function getSubmitIdentity(type) {
  const selectId = { sales: 'sales-submitted-by', adjustments: 'adjustment-submitted-by', cashout: 'expense-submitted-by' }[type];
  const pinId = { sales: 'sales-pin', adjustments: 'adjustment-pin', cashout: 'expense-pin' }[type];
  return {
    submittedBy: document.getElementById(selectId)?.value || '',
    userPin: document.getElementById(pinId)?.value || '',
    pinId
  };
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
    setStatus('Select employee and enter PIN', 'error');
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
    setStatus('Loading stock levels...', 'warning');
    const res = await apiRequest('stock', {});
    if (!res.ok) throw new Error('Failed to load stock');
    
    allStoreProducts = res.data || [];
    populateStockTable(allStoreProducts);
    document.getElementById('stock-modal').style.display = 'flex';
    
    const searchInput = document.getElementById('stock-search');
    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = () => {
        const term = searchInput.value.toLowerCase().trim();
        const filtered = allStoreProducts.filter(p => !term || String(p.productName).toLowerCase().includes(term));
        populateStockTable(filtered);
      };
    }
    setStatus('Stock levels loaded', 'success');
  } catch (error) {
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
  
  let outCount = 0, lowCount = 0;
  list.forEach(p => {
    const one = Number(p.stockOneStop) || 0;
    const two = Number(p.stockGolden) || 0;
    let label = 'OK', cls = 'status-ok';
    if (one <= 0 && two <= 0) { label = 'OUT'; cls = 'status-out'; outCount++; }
    else if (one <= 5 || two <= 5) { label = 'LOW'; cls = 'status-low'; lowCount++; }
    
    const tr = document.createElement('tr');
    tr.innerHTML = ` <td>${p.productName}</td><td>${formatMoney(one)}</td><td>${formatMoney(two)}</td><td class="${cls}">${label}</td> `;
    tbody.appendChild(tr);
  });
  
  const summary = document.getElementById('stock-summary');
  if (summary) summary.textContent = `Products: ${list.length} | Out: ${outCount} | Low: ${lowCount}`;
}

function showStockAdjustment() {
  adjustmentItems = [];
  document.getElementById('adjustment-store-name').textContent = storeName();
  updateAdjustmentTable();
  document.getElementById('stock-adjustment-modal').style.display = 'flex';
  const input = document.getElementById('adjustment-search');
  if (input) { input.value = ''; input.focus(); }
  const info = document.getElementById('adjustment-stock-info');
  if (info) info.textContent = 'Search an item to view stock';
}

function hideStockAdjustment() {
  document.getElementById('stock-adjustment-modal').style.display = 'none';
}

function addItemToAdjustment() {
  const name = document.getElementById('adjustment-search').value.trim();
  const p = products.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { setStatus('Product not found', 'error'); return; }
  if (adjustmentItems.some(x => x.name === p.name)) { setStatus('Item already added', 'warning'); return; }
  
  adjustmentItems.push({ name: p.name, unit: 'pc', adjustmentType: 'add', quantity: 0 });
  document.getElementById('adjustment-search').value = '';
  updateAdjustmentTable();
  setStatus('Item added to adjustment', 'success');
}

function updateAdjustmentTable() {
  const tbody = document.getElementById('adjustment-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (!adjustmentItems.length) {
    tbody.innerHTML = ' <tr><td colspan="5" class="muted">No items added yet</td></tr> ';
  } else {
    adjustmentItems.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.name}</td>
        <td><select onchange="updateAdjustmentUnit(${index}, this.value)">
          <option value="pc" ${item.unit === 'pc' ? 'selected' : ''}>pc</option>
          <option value="dz" ${item.unit === 'dz' ? 'selected' : ''}>dz</option>
          <option value="ct" ${item.unit === 'ct' ? 'selected' : ''}>ct</option>
        </select></td>
        <td><select onchange="updateAdjustmentType(${index}, this.value)">
          <option value="add" ${item.adjustmentType === 'add' ? 'selected' : ''}>Add Stock</option>
          <option value="remove" ${item.adjustmentType === 'remove' ? 'selected' : ''}>Remove Stock</option>
        </select></td>
        <td><input type="number" value="${item.quantity}" onchange="updateAdjustmentQuantity(${index}, this.value)" placeholder="Quantity"></td>
        <td><button class="btn-mini" onclick="removeAdjustmentItem(${index})">×</button></td>
      `;
      tbody.appendChild(tr);
    });
  }
  
  const summary = document.getElementById('adjustment-summary');
  if (summary) summary.textContent = `Items to adjust: ${adjustmentItems.length}`;
}

function updateAdjustmentUnit(index, unit) { if (adjustmentItems[index]) adjustmentItems[index].unit = unit; }
function updateAdjustmentType(index, type) { if (adjustmentItems[index]) adjustmentItems[index].adjustmentType = type; }
function updateAdjustmentQuantity(index, quantity) { if (adjustmentItems[index]) adjustmentItems[index].quantity = parseFloat(quantity) || 0; }
function removeAdjustmentItem(index) { adjustmentItems.splice(index, 1); updateAdjustmentTable(); }
function clearAdjustments() { adjustmentItems = []; updateAdjustmentTable(); setStatus('Adjustment cleared', 'info'); }

function submitStockAdjustment() {
  if (!adjustmentItems.length) { setStatus('No adjustments to submit', 'error'); return; }
  const { submittedBy, userPin, pinId } = getSubmitIdentity('adjustments');
  if (!submittedBy || !userPin) { setStatus('Select employee and enter PIN', 'error'); return; }
  
  const payload = { store: storeName(), submittedBy, userPin, items: adjustmentItems, timestamp: new Date().toISOString() };
  const count = adjustmentItems.length;
  adjustmentItems = [];
  updateAdjustmentTable();
  clearPin(pinId);
  queueAndSync('adjustments', payload, `${count} adjustment(s) queued.`);
  hideStockAdjustment();
}

function showExpenseModal() { document.getElementById('expense-modal').style.display = 'flex'; }
function hideExpenseModal() { document.getElementById('expense-modal').style.display = 'none'; }

function submitExpense() {
  const category = document.getElementById('expense-category').value.trim();
  const amount = parseMoney(document.getElementById('expense-amount').value);
  const paymentMethod = document.getElementById('expense-payment').value;
  const description = document.getElementById('expense-description').value.trim();
  
  if (!category) { setStatus('Please enter a category', 'error'); return; }
  if (!amount || amount <= 0) { setStatus('Please enter a valid amount', 'error'); return; }
  
  const { submittedBy, userPin, pinId } = getSubmitIdentity('cashout');
  if (!submittedBy || !userPin) { setStatus('Select employee and enter PIN', 'error'); return; }
  
  const payload = { store: storeName(), submittedBy, userPin, category, amount, paymentMethod, description, timestamp: new Date().toISOString() };
  clearPin(pinId);
  hideExpenseModal();
  document.getElementById('expense-category').value = '';
  document.getElementById('expense-amount').value = '';
  document.getElementById('expense-description').value = '';
  queueAndSync('cashout', payload, `Expense of ${formatMoney(amount)} queued.`);
}

// DOM Event Listeners
document.addEventListener('DOMContentLoaded', function() {
  const saleForm = document.getElementById('sale-form');
  if (saleForm) saleForm.addEventListener('submit', e => { e.preventDefault(); addToSale(); });
  attachMoneyFormatting();
  
  const itemInput = document.getElementById('item');
  if (itemInput) { itemInput.addEventListener('change', updatePrice); itemInput.addEventListener('input', updateSelectedStockInfo); }
  const unitSelect = document.getElementById('unit');
  if (unitSelect) unitSelect.addEventListener('change', updatePrice);
  const quantityInput = document.getElementById('quantity');
  if (quantityInput) quantityInput.addEventListener('input', calculateTotal);
  const adjustmentSearch = document.getElementById('adjustment-search');
  if (adjustmentSearch) adjustmentSearch.addEventListener('input', updateAdjustmentStockInfo);
  
  console.log('POS System Initialized');
});

// Expose functions globally
window.selectStore = selectStore;
window.removeSale = removeSale;
window.clearAllSales = clearAllSales;
window.submitAllSales = submitAllSales;
window.showStockLevels = showStockLevels;
window.hideStockLevels = hideStockLevels;
window.showStockAdjustment = showStockAdjustment;
window.hideStockAdjustment = hideStockAdjustment;
window.addItemToAdjustment = addItemToAdjustment;
window.updateAdjustmentUnit = updateAdjustmentUnit;
window.updateAdjustmentType = updateAdjustmentType;
window.updateAdjustmentQuantity = updateAdjustmentQuantity;
window.removeAdjustmentItem = removeAdjustmentItem;
window.clearAdjustments = clearAdjustments;
window.submitStockAdjustment = submitStockAdjustment;
window.showExpenseModal = showExpenseModal;
window.hideExpenseModal = hideExpenseModal;
window.submitExpense = submitExpense;
