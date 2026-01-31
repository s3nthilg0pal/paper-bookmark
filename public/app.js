// ============== API Configuration ==============
const API_BASE = '/api';

// ============== SSE Configuration ==============
let eventSource = null;
let sseReconnectAttempts = 0;
const SSE_MAX_RECONNECT_ATTEMPTS = 5;
const SSE_RECONNECT_DELAY = 3000;
let sseEnabled = true;

// ============== State ==============
let papers = [];
let allTags = [];
let currentEditId = null;
let deleteId = null;
let searchTimeout = null;
const SSR_MODE = window.__SSR__ === true || document.body?.dataset?.ssr === 'true';

// ============== DOM Elements ==============
const papersList = document.getElementById('papersList');
const emptyState = document.getElementById('emptyState');
const loadingState = document.getElementById('loadingState');
const paperModal = document.getElementById('paperModal');
const deleteModal = document.getElementById('deleteModal');
const paperForm = document.getElementById('paperForm');
const tagFilter = document.getElementById('tagFilter');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');

// ============== Initialize ==============
document.addEventListener('DOMContentLoaded', () => {
  const initialData = window.__INITIAL_DATA__;
  const hasInitialData = initialData && Array.isArray(initialData.papers);

  if (hasInitialData) {
    papers = initialData.papers;
    allTags = Array.isArray(initialData.tags) ? initialData.tags : [];
    renderPapers();
    renderTagFilter();
    showLoading(false);
  }

  if (!SSR_MODE) {
    loadPapers({ silent: hasInitialData });
    loadTags({ silent: hasInitialData });
  }
  initSSE();
});

// ============== SSE Functions (Server-Sent Events) ==============
function initSSE() {
  if (!sseEnabled || !window.EventSource) {
    showConnectionStatus(false, true);
    return;
  }
  
  try {
    eventSource = new EventSource(`${API_BASE}/events`);
    
    eventSource.onopen = () => {
      console.log('🔄 Real-time sync connected (SSE)');
      sseReconnectAttempts = 0;
      showConnectionStatus(true);
    };
    
    eventSource.addEventListener('connected', (e) => {
      console.log('SSE connected:', JSON.parse(e.data));
    });
    
    eventSource.addEventListener('paper:created', (e) => {
      handlePaperCreated(JSON.parse(e.data));
    });
    
    eventSource.addEventListener('paper:updated', (e) => {
      handlePaperUpdated(JSON.parse(e.data));
    });
    
    eventSource.addEventListener('paper:deleted', (e) => {
      handlePaperDeleted(JSON.parse(e.data));
    });
    
    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      showConnectionStatus(false);
      
      if (eventSource.readyState === EventSource.CLOSED) {
        attemptReconnect();
      }
    };
  } catch (error) {
    console.error('SSE init error:', error);
    sseEnabled = false;
    showConnectionStatus(false, true);
  }
}

function attemptReconnect() {
  if (!sseEnabled) return;
  
  if (sseReconnectAttempts < SSE_MAX_RECONNECT_ATTEMPTS) {
    sseReconnectAttempts++;
    const delay = SSE_RECONNECT_DELAY * Math.min(sseReconnectAttempts, 3);
    console.log(`Reconnecting in ${delay/1000}s... (attempt ${sseReconnectAttempts})`);
    setTimeout(initSSE, delay);
  } else {
    console.log('Max reconnect attempts reached. Real-time sync disabled.');
    sseEnabled = false;
    showConnectionStatus(false, true);
  }
}

function handlePaperCreated(newPaper) {
  if (SSR_MODE) {
    window.location.reload();
    return;
  }
  // Check if paper already exists (might be from our own action)
  const exists = papers.some(p => p._id === newPaper._id);
  if (!exists) {
    // Reload to respect current sort/filter
    loadPapers();
    loadTags();
    showToast('New paper added on another device', 'success');
  }
}

function handlePaperUpdated(updatedPaper) {
  if (SSR_MODE) {
    window.location.reload();
    return;
  }
  const index = papers.findIndex(p => p._id === updatedPaper._id);
  if (index !== -1) {
    papers[index] = updatedPaper;
    renderPapers();
    loadTags();
  }
}

function handlePaperDeleted(data) {
  if (SSR_MODE) {
    window.location.reload();
    return;
  }
  const index = papers.findIndex(p => p._id === data._id);
  if (index !== -1) {
    papers.splice(index, 1);
    renderPapers();
    loadTags();
  }
}

function showConnectionStatus(connected, disabled = false) {
  // Update UI to show connection status
  const existingIndicator = document.getElementById('syncIndicator');
  if (existingIndicator) {
    if (disabled) {
      existingIndicator.className = 'sync-indicator disabled';
      existingIndicator.title = 'Real-time sync unavailable - refresh to update';
    } else {
      existingIndicator.className = `sync-indicator ${connected ? 'connected' : 'disconnected'}`;
      existingIndicator.title = connected ? 'Real-time sync active' : 'Reconnecting...';
    }
  }
}

// ============== API Functions ==============
async function loadPapers(options = {}) {
  if (SSR_MODE) return;
  const { silent = false } = options;
  try {
    if (!silent) {
      showLoading(true);
    }
    
    const search = searchInput.value.trim();
    const tag = tagFilter.value;
    const [sort, order] = sortSelect.value.split('-');
    
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (tag) params.append('tag', tag);
    params.append('sort', sort);
    params.append('order', order);
    
    const response = await fetch(`${API_BASE}/papers?${params}`);
    const data = await response.json();
    
    if (data.success) {
      papers = data.data;
      renderPapers();
    } else if (!silent) {
      showToast('Failed to load papers', 'error');
    }
  } catch (error) {
    console.error('Error loading papers:', error);
    if (!silent) {
      showToast('Error connecting to server', 'error');
    }
  } finally {
    if (!silent) {
      showLoading(false);
    }
  }
}

async function loadTags(options = {}) {
  if (SSR_MODE) return;
  const { silent = false } = options;
  try {
    const response = await fetch(`${API_BASE}/tags`);
    const data = await response.json();
    
    if (data.success) {
      allTags = data.data;
      renderTagFilter();
    }
  } catch (error) {
    if (!silent) {
      console.error('Error loading tags:', error);
    }
  }
}

async function savePaper(paperData) {
  try {
    const isEdit = !!paperData._id;
    const url = isEdit 
      ? `${API_BASE}/papers/${paperData._id}`
      : `${API_BASE}/papers`;
    
    const response = await fetch(url, {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paperData)
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(isEdit ? 'Paper updated!' : 'Paper saved!', 'success');
      closeModal();
      if (SSR_MODE) {
        window.location.reload();
        return;
      }
      loadPapers();
      loadTags();
    } else {
      showToast(data.error || 'Failed to save paper', 'error');
    }
  } catch (error) {
    console.error('Error saving paper:', error);
    showToast('Error saving paper', 'error');
  }
}

async function deletePaper(id) {
  try {
    const response = await fetch(`${API_BASE}/papers/${id}`, {
      method: 'DELETE'
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast('Paper deleted', 'success');
      if (SSR_MODE) {
        window.location.reload();
        return;
      }
      loadPapers();
      loadTags();
    } else {
      showToast(data.error || 'Failed to delete paper', 'error');
    }
  } catch (error) {
    console.error('Error deleting paper:', error);
    showToast('Error deleting paper', 'error');
  }
}

async function trackAccess(id) {
  if (SSR_MODE) return;
  try {
    await fetch(`${API_BASE}/papers/${id}/access`, { method: 'POST' });
  } catch (error) {
    console.error('Error tracking access:', error);
  }
}

async function fetchMetadata() {
  const urlInput = document.getElementById('paperUrl');
  const url = urlInput.value.trim();
  
  if (!url) {
    showToast('Please enter a URL first', 'error');
    return;
  }
  
  const fetchBtn = document.querySelector('.fetch-btn');
  const fetchBtnText = document.getElementById('fetchBtnText');
  
  try {
    fetchBtn.disabled = true;
    fetchBtnText.textContent = 'Fetching...';
    
    const response = await fetch(`${API_BASE}/fetch-metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    
    const data = await response.json();
    
    if (data.success && data.data) {
      const { title, authors, abstract } = data.data;
      
      if (title) document.getElementById('paperTitle').value = title;
      if (authors) document.getElementById('paperAuthors').value = authors;
      if (abstract) document.getElementById('paperAbstract').value = abstract;
      
      showToast('Metadata fetched!', 'success');
    } else {
      showToast('Could not fetch metadata', 'error');
    }
  } catch (error) {
    console.error('Error fetching metadata:', error);
    showToast('Error fetching metadata', 'error');
  } finally {
    fetchBtn.disabled = false;
    fetchBtnText.textContent = 'Fetch Info';
  }
}

// ============== Render Functions ==============
function renderPapers() {
  if (papers.length === 0) {
    papersList.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }
  
  papersList.classList.remove('hidden');
  emptyState.classList.add('hidden');
  
  papersList.innerHTML = papers.map(paper => `
    <article class="paper-card" onclick="openPaper('${paper._id}', '${escapeHtml(paper.url)}')">
      <div class="paper-header">
        <span class="paper-source ${paper.source.toLowerCase().replace(/\s+/g, '')}">${paper.source}</span>
        <div class="paper-actions" onclick="event.stopPropagation()">
          <button class="paper-action-btn" onclick="editPaper('${paper._id}')" title="Edit">✏️</button>
          <button class="paper-action-btn" onclick="openDeleteModal('${paper._id}')" title="Delete">🗑️</button>
        </div>
      </div>
      <h3 class="paper-title">${escapeHtml(paper.title)}</h3>
      ${paper.authors ? `<p class="paper-authors">${escapeHtml(paper.authors)}</p>` : ''}
      ${paper.abstract ? `<p class="paper-abstract">${escapeHtml(paper.abstract)}</p>` : ''}
      <div class="paper-footer">
        <div class="paper-tags">
          ${paper.tags.map(tag => `<span class="paper-tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
        <span class="paper-date">${formatDate(paper.dateAdded)}</span>
      </div>
    </article>
  `).join('');
}

function renderTagFilter() {
  const currentValue = tagFilter.value;
  
  tagFilter.innerHTML = `
    <option value="">All Tags</option>
    ${allTags.map(tag => `
      <option value="${escapeHtml(tag)}" ${tag === currentValue ? 'selected' : ''}>
        ${escapeHtml(tag)}
      </option>
    `).join('')}
  `;
}

// ============== Event Handlers ==============
function handleSearch() {
  if (SSR_MODE) return;
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadPapers, 300);
}

function handleFilter() {
  if (SSR_MODE) return;
  loadPapers();
}

function handleSubmit(event) {
  event.preventDefault();
  
  const paperData = {
    url: document.getElementById('paperUrl').value.trim(),
    title: document.getElementById('paperTitle').value.trim(),
    authors: document.getElementById('paperAuthors').value.trim(),
    abstract: document.getElementById('paperAbstract').value.trim(),
    tags: document.getElementById('paperTags').value
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 0)
  };
  
  const editId = document.getElementById('paperId').value;
  if (editId) {
    paperData._id = editId;
  }
  
  savePaper(paperData);
}

function openPaper(id, url) {
  trackAccess(id);
  window.open(url, '_blank');
}

function openAddModal() {
  currentEditId = null;
  document.getElementById('modalTitle').textContent = 'Add Paper';
  document.getElementById('submitBtn').textContent = 'Save Paper';
  paperForm.reset();
  document.getElementById('paperId').value = '';
  paperModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function editPaper(id) {
  const paper = papers.find(p => p._id === id);
  if (!paper) return;
  
  currentEditId = id;
  document.getElementById('modalTitle').textContent = 'Edit Paper';
  document.getElementById('submitBtn').textContent = 'Update Paper';
  
  document.getElementById('paperId').value = paper._id;
  document.getElementById('paperUrl').value = paper.url;
  document.getElementById('paperTitle').value = paper.title;
  document.getElementById('paperAuthors').value = paper.authors || '';
  document.getElementById('paperAbstract').value = paper.abstract || '';
  document.getElementById('paperTags').value = paper.tags.join(', ');
  
  paperModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  paperModal.classList.add('hidden');
  document.body.style.overflow = '';
  paperForm.reset();
}

function openDeleteModal(id) {
  deleteId = id;
  deleteModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDeleteModal() {
  deleteModal.classList.add('hidden');
  document.body.style.overflow = '';
  deleteId = null;
}

function confirmDelete() {
  if (deleteId) {
    deletePaper(deleteId);
    closeDeleteModal();
  }
}

// ============== Utility Functions ==============
function showLoading(show) {
  if (show) {
    loadingState.classList.remove('hidden');
    papersList.classList.add('hidden');
    emptyState.classList.add('hidden');
  } else {
    loadingState.classList.add('hidden');
  }
}

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  
  toast.className = `toast ${type}`;
  toastMessage.textContent = message;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now - date);
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

// ============== Keyboard Shortcuts ==============
document.addEventListener('keydown', (e) => {
  // Escape to close modals
  if (e.key === 'Escape') {
    if (!paperModal.classList.contains('hidden')) {
      closeModal();
    }
    if (!deleteModal.classList.contains('hidden')) {
      closeDeleteModal();
    }
  }
  
  // Ctrl/Cmd + K to focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    searchInput.focus();
  }
  
  // Ctrl/Cmd + N to add new paper
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    openAddModal();
  }
});
