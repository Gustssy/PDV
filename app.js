/**
 * Nexus PDV - Main Application Logic
 * Utilizes LocalStorage for data persistence to allow serverless execution on any device.
 */

const pdvApp = (function () {
    // --- Custom Modals ---
    function showCustomAlert(message, title = 'Aviso') {
        const modal = document.getElementById('custom-alert-modal');
        const titleEl = document.getElementById('custom-alert-title');
        const msgEl = document.getElementById('custom-alert-message');
        const okBtn = document.getElementById('custom-alert-ok');
        
        if (!modal) {
            window.alert(message); // Fallback
            return Promise.resolve();
        }

        if (title) {
            titleEl.textContent = title;
            titleEl.style.display = 'block';
        } else {
            titleEl.style.display = 'none';
        }

        msgEl.textContent = message;
        modal.classList.add('active');

        return new Promise(resolve => {
            const closeModal = () => {
                modal.classList.remove('active');
                okBtn.removeEventListener('click', closeModal);
                resolve();
            };
            okBtn.addEventListener('click', closeModal);
        });
    }

    function showCustomConfirm(message, title = 'Confirmação') {
        const modal = document.getElementById('custom-confirm-modal');
        const titleEl = document.getElementById('custom-confirm-title');
        const msgEl = document.getElementById('custom-confirm-message');
        const yesBtn = document.getElementById('custom-confirm-yes');
        const noBtn = document.getElementById('custom-confirm-no');
        
        if (!modal) {
            return Promise.resolve(window.confirm(message)); // Fallback
        }

        titleEl.textContent = title;
        msgEl.textContent = message;
        modal.classList.add('active');

        return new Promise(resolve => {
            const cleanup = () => {
                modal.classList.remove('active');
                yesBtn.removeEventListener('click', onYes);
                noBtn.removeEventListener('click', onNo);
            };
            
            const onYes = () => { cleanup(); resolve(true); };
            const onNo = () => { cleanup(); resolve(false); };
            
            yesBtn.addEventListener('click', onYes);
            noBtn.addEventListener('click', onNo);
        });
    }

    // Export to window to allow replacing native calls easily if needed
    window.showCustomAlert = showCustomAlert;
    window.showCustomConfirm = showCustomConfirm;

    // --- State & DB ---
    let db = {
        products: [],
        clients: [],
        comandas: [],
        sales: []
    };

    let currentCart = [];
    let currentPaymentMethod = 'Dinheiro';
    const FEIRANTE_PAYMENT_OPTIONS = ['Débito', 'Crédito', 'PIX', 'Dinheiro', 'Troca'];
    let pendingFeiranteChargeComandaId = null;

    // UI State
    let isComandasPanelOpen = false;
    let currentPagersFilter = 'occupied';
    let currentSelectedComandaId = null;
    let dashboardValuesVisible = false;
    let currentFeira = JSON.parse(localStorage.getItem('pdv_current_feira')) || null;
    let inactiveCategories = JSON.parse(localStorage.getItem('pdv_inactive_categories')) || [];

    function isCategoryActive(catName) {
        if (!catName) return true;
        const normalized = String(catName).trim().toLowerCase();
        return !inactiveCategories.some(ic => String(ic).trim().toLowerCase() === normalized);
    }

    function toggleCategoryStatus(catName) {
        if (!catName) return;
        const idx = inactiveCategories.indexOf(catName);
        if (idx > -1) {
            inactiveCategories.splice(idx, 1);
            showToast(`Categoria "${catName}" foi ATIVADA.`, 'success');
        } else {
            inactiveCategories.push(catName);
            showToast(`Categoria "${catName}" foi INATIVADA.`, 'warning');
        }
        localStorage.setItem('pdv_inactive_categories', JSON.stringify(inactiveCategories));
        renderCategories();
        renderPDVProducts();
        renderProductsTable();
        renderCategoryManagementModal();
    }

    function openCategoryManagementModal() {
        renderCategoryManagementModal();
        openModal('modal-categorias');
    }

    function renderCategoryManagementModal() {
        const listEl = document.getElementById('category-management-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        const sellable = db.products.filter(p => !p.isRawMaterial);
        const allCategories = [...new Set(sellable.map(p => p.category).filter(Boolean))];
        
        if (allCategories.length === 0) {
            listEl.innerHTML = '<div style="text-align:center; color: var(--text-muted); padding: 1rem;">Nenhuma categoria cadastrada nos produtos.</div>';
            return;
        }

        allCategories.forEach(cat => {
            const active = isCategoryActive(cat);
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 10px 14px; border-radius: 8px;';
            row.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: 600; font-size: 0.95rem;">${cat}</span>
                    ${active 
                        ? '<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: var(--success); font-size: 0.75rem; padding: 2px 8px; border-radius: 12px;">Ativa</span>' 
                        : '<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: var(--danger); font-size: 0.75rem; padding: 2px 8px; border-radius: 12px;">Inativa</span>'}
                </div>
                <button class="btn ${active ? 'danger' : 'success'}" onclick="pdvApp.toggleCategoryStatus('${cat}')" style="padding: 4px 12px; font-size: 0.8rem;">
                    <i class="fa-solid ${active ? 'fa-ban' : 'fa-check'}"></i> ${active ? 'Inativar' : 'Ativar'}
                </button>
            `;
            listEl.appendChild(row);
        });
    }

    // Default initial data for demo
    const defaultProducts = [
        { id: '1', sku: '001', category: 'Bebidas', name: 'Refrigerante Lata', price: 5.50, stock: 50 },
        { id: '2', sku: '002', category: 'Alimentos', name: 'Salgado Assado', price: 7.00, stock: 30 },
        { id: '3', sku: '003', category: 'Bebidas', name: 'Água Mineral 500ml', price: 3.00, stock: 100 },
        { id: '4', sku: '004', category: 'Doces', name: 'Chocolate Barra', price: 9.90, stock: 20 },
        { id: '5', sku: '005', category: 'Bebidas', name: 'Café Espresso', price: 4.50, stock: 200 }
    ];

    // --- Supabase Config ---
    const supabaseUrl = 'https://esszyrczuipzmsvkxnwn.supabase.co';
    const supabaseKey = 'sb_publishable_0H-TgPw4csT53m6_QEQuqQ_0Ib51bs-';
    const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

    function showLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.style.display = 'flex';
    }

    function hideLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.style.display = 'none';
    }

    // --- Initialization ---
    async function init() {
        showLoading();
        await loadData();
        setupNavigation();
        setupRealTimeClock();
        setupEventListeners();
        renderAll();
        setupRealtimeSubscriptions();
        loadWebOrders(); // Carrega pedidos web em background
        hideLoading();
    }

    // --- DB Data Mappers ---
    // Mapeamento estrito para as colunas exatas que existem no banco de dados
    function mapProductToDB(p) {
        return {
            id: String(p.id), sku: p.sku, category: p.category, name: p.name, price: p.price, stock: p.stock,
            iscomposed: p.isComposed === true || p.isComposed === 'true',
            composition: p.composition,
            israwmaterial: p.isRawMaterial === true || p.isRawMaterial === 'true',
            unit: p.unit,
            iscustomizable: p.isCustomizable === true || p.isCustomizable === 'true',
            updated_at: new Date().toISOString()
        };
    }
    function mapProductFromDB(p) {
        return {
            ...p,
            isComposed: p.iscomposed === true || p.iscomposed === 'true',
            isRawMaterial: p.israwmaterial === true || p.israwmaterial === 'true',
            isCustomizable: p.iscustomizable === true || p.iscustomizable === 'true'
        };
    }

    function mapComandaToDB(c) {
        return {
            id: String(c.id), number: (c.number === '' || c.number === undefined || c.number === null) ? null : parseInt(c.number), status: c.status, client: c.client, date: c.date,
            items: c.items, total: c.total, paid: c.paid, ispageless: c.isPageless,
            paymentmethod: c.paymentMethod, isfeirante: c.isFeirante,
            updated_at: new Date().toISOString()
        };
    }
    function mapComandaFromDB(c) {
        return { ...c, isPageless: c.ispageless, paymentMethod: c.paymentmethod, isFeirante: c.isfeirante };
    }

    function mapSaleToDB(s) {
        return {
            id: String(s.id), type: s.type, date: s.date, total: s.total, items: s.items, paymentmethod: s.paymentMethod,
            comanda: s.comanda || '', client: s.client || '',
            feiralocation: s.feiraLocation || '', isviagem: s.isViagem || false,
            isfeirante: s.isFeirante || false,
            iscanceled: s.isCanceled || false,
            received: typeof s.received === 'number' ? s.received : 0,
            change: typeof s.change === 'number' ? s.change : 0,
            updated_at: new Date().toISOString()
        };
    }
    function mapSaleFromDB(s) {
        return {
            ...s,
            paymentMethod: s.paymentmethod,
            feiraLocation: s.feiralocation,
            isViagem: s.isviagem === true || s.isviagem === 'true',
            isFeirante: s.isfeirante === true || s.isfeirante === 'true',
            isCanceled: s.iscanceled === true || s.iscanceled === 'true',
            received: typeof s.received === 'number' ? s.received : Number(s.received || 0),
            change: typeof s.change === 'number' ? s.change : Number(s.change || 0)
        };
    };

    function mapFeiraToDB(f) {
        return {
            id: String(f.id), location: f.location, date: f.date, obs: f.obs || '', status: f.status,
            caixainicial: f.caixaInicial, openedat: f.openedAt, closedat: f.closedAt || null, totalvendido: f.totalVendido || null
        };
    }
    function mapFeiraFromDB(f) {
        return {
            id: f.id, location: f.location, date: f.date, obs: f.obs, status: f.status,
            caixaInicial: f.caixainicial, openedAt: f.openedat, closedAt: f.closedat, totalVendido: f.totalvendido
        };
    }

    async function loadData() {
        try {
            const [resProducts, resClients, resComandas, resSales, resSettings, resFeiras] = await Promise.all([
                supabase.from('products').select('*'),
                supabase.from('clients').select('*'),
                supabase.from('comandas').select('*').order('date', { ascending: false }).limit(1000),
                supabase.from('sales').select('*').order('date', { ascending: false }).limit(1000),
                supabase.from('settings').select('*').eq('id', 'global_settings').limit(1),
                supabase.from('feiras').select('*').eq('status', 'open').order('openedat', { ascending: false }).limit(1)
            ]);

            if (resProducts.error) throw resProducts.error;

            if (resProducts.data) db.products = resProducts.data.map(mapProductFromDB);
            if (resClients.data) db.clients = resClients.data;
            if (resComandas.data) db.comandas = resComandas.data.map(mapComandaFromDB);
            if (resSales.data) db.sales = resSales.data.map(mapSaleFromDB);

            if (resSettings && !resSettings.error && resSettings.data && resSettings.data.length > 0) {
                const s = resSettings.data[0].data;
                if (s && s.VARIATIONS_DONENESS) VARIATIONS_DONENESS = s.VARIATIONS_DONENESS;
                if (s && s.VARIATIONS_INGREDIENTS) VARIATIONS_INGREDIENTS = s.VARIATIONS_INGREDIENTS;
                if (s && s.VARIATIONS_EXTRAS) VARIATIONS_EXTRAS = s.VARIATIONS_EXTRAS;
            }
            if (resSettings && resSettings.error) console.warn('Erro ao carregar settings:', resSettings.error.message);

            console.log('Feiras query result:', JSON.stringify(resFeiras));
            if (resFeiras && resFeiras.error) {
                console.warn('Erro ao carregar feiras:', resFeiras.error.message);
            }
            if (resFeiras && !resFeiras.error && resFeiras.data && resFeiras.data.length > 0) {
                currentFeira = mapFeiraFromDB(resFeiras.data[0]);
                localStorage.setItem('pdv_current_feira', JSON.stringify(currentFeira));
                console.log('Feira aberta carregada da nuvem:', currentFeira);
            } else {
                console.log('Nenhuma feira aberta encontrada na nuvem.');
            }

            // --- RECUPERAÇÃO DE DADOS DO LOCALSTORAGE ---
            const oldDataStr = localStorage.getItem('nexus_pdv_db');
            const isMigrated = localStorage.getItem('migrated_to_supabase');

            if (oldDataStr && !isMigrated) {
                console.log("Migrando dados antigos para o Supabase...");
                const oldDb = JSON.parse(oldDataStr);
                showLoading();

                try {
                    if (oldDb.products && oldDb.products.length > 0) {
                        const dbData = oldDb.products.map(mapProductToDB);
                        await supabase.from('products').upsert(dbData);
                        db.products = oldDb.products;
                    }
                    if (oldDb.comandas && oldDb.comandas.length > 0) {
                        const openComandas = oldDb.comandas.filter(c => c.status === 'open');
                        const dbData = oldDb.comandas.map(mapComandaToDB);
                        await supabase.from('comandas').upsert(dbData);
                        db.comandas = openComandas;
                    }
                    if (oldDb.sales && oldDb.sales.length > 0) {
                        const recentSales = oldDb.sales.slice(-200);
                        const dbData = recentSales.map(mapSaleToDB);
                        await supabase.from('sales').upsert(dbData);
                        db.sales = oldDb.sales;
                    }
                    if (oldDb.clients && oldDb.clients.length > 0) {
                        await supabase.from('clients').upsert(oldDb.clients);
                        db.clients = oldDb.clients;
                    }

                    localStorage.setItem('migrated_to_supabase', 'true');

                } catch (e) {
                    console.error("Erro na migração para o Supabase", e);
                    throw new Error("Falha ao comunicar com Supabase na migração.");
                }
                hideLoading();

            } else if (db.products.length === 0 && !oldDataStr) {
                db.products = [...defaultProducts];
                await supabase.from('products').insert(defaultProducts.map(mapProductToDB));
            }

            localStorage.setItem('nexus_pdv_db_backup', JSON.stringify(db));

        } catch (error) {
            console.error("Erro Crítico de Conexão com Supabase:", error);

            const backup = localStorage.getItem('nexus_pdv_db') || localStorage.getItem('nexus_pdv_db_backup');
            if (backup) {
                const oldDb = JSON.parse(backup);
                db.products = oldDb.products || [];
                db.comandas = oldDb.comandas || [];
                db.sales = oldDb.sales || [];
                db.clients = oldDb.clients || [];
            } else {
                db.products = [...defaultProducts];
            }
        }
    }

    function saveDataLocal() {
        localStorage.setItem('nexus_pdv_db_backup', JSON.stringify(db));
    }

    function generateItemsSummary(items) {
        if (!items || items.length === 0) return "Nenhum item";
        return items.map(item => {
            let str = `${item.qty}x ${item.name}`;
            let details = [];
            if (item.observation) details.push(item.observation);
            if (item.addons && item.addons.length > 0) {
                item.addons.forEach(a => details.push(`+${a.qty}x ${a.name}`));
            }
            if (details.length > 0) str += ` (${details.join(', ')})`;
            return str;
        }).join(' | ');
    }

    // --- Realtime Subscriptions ---
    function setupRealtimeSubscriptions() {
        supabase.channel('custom-all-channel')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'comandas' }, payload => {
                handleRealtimeUpdate('comandas', payload, mapComandaFromDB);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, payload => {
                handleRealtimeUpdate('sales', payload, mapSaleFromDB);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, payload => {
                handleRealtimeUpdate('products', payload, mapProductFromDB);
            })
            .subscribe();

        // Escuta novos pedidos web e atualizações
        supabase.channel('web-orders-channel')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'web_orders' }, payload => {
                if (payload.new) {
                    // Ignorar se não estiver pago (a menos que seja manual)
                    if (payload.new.payment_status === 'pending' && payload.new.status === 'waiting_payment') return;
                    
                    webOrders.unshift(payload.new);
                    renderWebOrders();
                    updateWebOrdersBadge();
                    if (payload.new.status === 'pending') {
                        showWebOrderModal(payload.new);
                    }
                }
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'web_orders' }, payload => {
                if (payload.new) {
                    const existingIdx = webOrders.findIndex(o => o.id === payload.new.id);
                    const isNewToPDV = existingIdx === -1 && payload.new.payment_status === 'approved';
                    
                    if (payload.new.status === 'cancellation_requested') {
                        const oldStatus = existingIdx > -1 ? webOrders[existingIdx].status : null;
                        if (oldStatus !== 'cancellation_requested') {
                            showCancellationModal(payload.new);
                        }
                    }

                    if (existingIdx > -1) {
                        webOrders[existingIdx] = payload.new;
                    } else if (payload.new.payment_status !== 'pending') {
                        webOrders.unshift(payload.new);
                        if (payload.new.status === 'pending') {
                            showWebOrderModal(payload.new);
                        }
                    }
                    
                    renderWebOrders();
                    updateWebOrdersBadge();
                }
            })
            .subscribe();
    }

    // Debounced renderAll for Realtime events – coalesces bursts into a single UI update
    let _debouncedRenderAll = null;
    function handleRealtimeUpdate(table, payload, mapper) {
        const { eventType, new: newRecRaw, old: oldRec } = payload;
        const list = db[table];

        if (eventType === 'INSERT' || eventType === 'UPDATE') {
            const newRec = mapper ? mapper(newRecRaw) : newRecRaw;
            const index = list.findIndex(item => String(item.id) === String(newRec.id));
            if (index > -1) {
                list[index] = newRec;
            } else {
                list.push(newRec);
            }
        } else if (eventType === 'DELETE') {
            const index = list.findIndex(item => String(item.id) === String(oldRec.id));
            if (index > -1) list.splice(index, 1);
        }

        // Lazy-init the debounced wrapper so renderAll is already in scope
        if (!_debouncedRenderAll) _debouncedRenderAll = debounce(renderAll, 300);
        _debouncedRenderAll();
    }

    async function syncFullDatabase() {
        showLoading();
        await loadData();
        renderAll();
        hideLoading();
        showCustomAlert('Sincronização bidirecional concluída com sucesso!');
    }

    // Wrappers para salvar no Supabase
    async function saveSaleToCloud(sale) {
        const res = await supabase.from('sales').upsert(mapSaleToDB(sale));
        if (res.error) showToast('Erro ao salvar venda: ' + res.error.message);
        saveDataLocal();
    }
    async function saveProductToCloud(product) {
        const res = await supabase.from('products').upsert(mapProductToDB(product));
        if (res.error) showToast('Erro ao salvar produto: ' + res.error.message);
        saveDataLocal();
    }
    async function deleteProductFromCloud(productId) {
        const res = await supabase.from('products').delete().eq('id', productId);
        if (res.error) showToast('Erro ao deletar produto: ' + res.error.message);
        saveDataLocal();
    }
    async function saveComandaToCloud(comanda) {
        const res = await supabase.from('comandas').upsert(mapComandaToDB(comanda));
        if (res.error) showToast('Erro ao salvar comanda: ' + res.error.message);
        saveDataLocal();
    }
    async function deleteComandaFromCloud(comandaId) {
        const res = await supabase.from('comandas').delete().eq('id', comandaId);
        if (res.error) showToast('Erro ao deletar comanda: ' + res.error.message);
        saveDataLocal();
    }
    async function saveClientToCloud(client) {
        const res = await supabase.from('clients').upsert(client);
        if (res.error) showToast('Erro ao salvar cliente: ' + res.error.message);
        saveDataLocal();
    }
    async function deleteClientFromCloud(clientId) {
        const res = await supabase.from('clients').delete().eq('id', clientId);
        if (res.error) showToast('Erro ao deletar cliente: ' + res.error.message);
        saveDataLocal();
    }
    async function saveSettingsToCloud(settings) {
        saveDataLocal();
        const res = await supabase.from('settings').upsert({ id: 'global_settings', data: settings });
        if (res.error) showToast('Erro ao salvar configurações na nuvem: ' + res.error.message);
    }

    async function saveFeiraToCloud(feiraObj) {
        const res = await supabase.from('feiras').upsert(mapFeiraToDB(feiraObj));
        if (res.error) showToast('Erro ao salvar feira na nuvem: ' + res.error.message);
    }

    // ─────────────────────────────────────────────────────────────────
    // --- Pedidos Web ---
    // ─────────────────────────────────────────────────────────────────
    let webOrders = [];
    let webOrdersFilter = 'all';

    async function loadWebOrders() {
        try {
            const { data, error } = await supabase
                .from('web_orders')
                .select('*')
                .neq('status', 'waiting_payment')
                .order('created_at', { ascending: false })
                .limit(200);
            if (error) throw error;
            webOrders = data || [];
            renderWebOrders();
            updateWebOrdersBadge();
        } catch(e) {
            console.error('Erro ao carregar pedidos web:', e);
            showToast('Erro ao carregar pedidos web: ' + e.message, 'error');
        }
    }

    function updateWebOrdersBadge() {
        const pending = webOrders.filter(o => o.status === 'pending' || o.status === 'seen').length;
        const badge = document.getElementById('web-orders-badge');
        if (!badge) return;
        if (pending > 0) {
            badge.textContent = pending;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    function filterWebOrders(filter) {
        webOrdersFilter = filter;
        // Update filter button styles
        ['all', 'pending', 'preparing', 'ready', 'done'].forEach(f => {
            const btn = document.getElementById(`filter-wo-${f}`);
            if (!btn) return;
            btn.style.background = f === filter ? 'var(--primary)' : '';
            btn.style.color = f === filter ? '#000' : '';
        });
        renderWebOrders();
    }

    function renderWebOrders() {
        const container = document.getElementById('web-orders-list');
        if (!container) return;

        let filtered = webOrdersFilter === 'all' ? webOrders : webOrders.filter(o => o.status === webOrdersFilter);

        if (filtered.length === 0) {
            container.innerHTML = `
                <div style="text-align:center;color:var(--text-muted);padding:40px;">
                    <i class="fa-solid fa-inbox" style="font-size:2rem;margin-bottom:10px;display:block;"></i>
                    Nenhum pedido ${webOrdersFilter !== 'all' ? 'com esse status ' : ''}encontrado.
                </div>`;
            return;
        }

        const statusConfig = {
            pending:   { label: 'Pendente',    color: '#f59e0b', next: 'preparing', nextLabel: '🍳 Iniciar Preparo' },
            seen:      { label: 'Visto',       color: '#6366f1', next: 'preparing', nextLabel: '🍳 Iniciar Preparo' },
            preparing: { label: 'Preparando',  color: '#3b82f6', next: 'ready',     nextLabel: '✅ Marcar Pronto' },
            ready:     { label: 'Pronto',      color: '#10b981', next: 'done',      nextLabel: '🛵 Marcar Entregue' },
            done:      { label: 'Entregue',    color: '#6b7280', next: null,        nextLabel: null },
        };

        const paymentLabels = {
            approved: { text: 'Pago', color: '#10b981' },
            pending:  { text: 'Ag. Pagamento', color: '#f59e0b' },
            manual:   { text: 'Pagar na Retirada', color: '#6366f1' },
            failed:   { text: 'Falhou', color: '#ef4444' },
            error:    { text: 'Erro', color: '#ef4444' },
        };

        const methodLabels = {
            creditCard:   '💳 Crédito',
            debitCard:    '🏧 Débito',
            bankTransfer: '📱 PIX',
            online:       '🌐 Online',
            manual:       '💵 Manual',
        };

        container.innerHTML = filtered.map(order => {
            const sc = statusConfig[order.status] || statusConfig['pending'];
            const pl = paymentLabels[order.payment_status] || { text: order.payment_status, color: '#6b7280' };
            const ml = methodLabels[order.payment_method] || order.payment_method;

            const items = Array.isArray(order.items) ? order.items : [];
            const itemsHtml = items.map(it =>
                `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.88rem;border-bottom:1px solid rgba(255,255,255,0.05);">
                    <span><strong>${it.qty}x</strong> ${it.name}</span>
                    <span style="color:var(--primary);">R$ ${Number(it.subtotal || it.price * it.qty).toFixed(2).replace('.', ',')}</span>
                </div>`
            ).join('');

            const obsHtml = order.observation ? `
                <div style="margin-top:8px;padding:8px;background:rgba(245,158,11,0.08);border-left:3px solid #f59e0b;border-radius:4px;font-size:0.82rem;color:#d97706;">
                    <i class="fa-solid fa-note-sticky" style="margin-right:4px;"></i>${order.observation}
                </div>` : '';

            const created = new Date(order.created_at).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });

            // WhatsApp link
            const phoneRaw = (order.client_phone || '').replace(/\D/g, '');
            const whatsappBase = phoneRaw ? `https://wa.me/55${phoneRaw}` : null;
            const waMessages = {
                preparing: `Olá ${order.client_name.split(' ')[0]}! Seu pedido está sendo preparado. Em breve estará pronto! 🍢`,
                ready:     `Olá ${order.client_name.split(' ')[0]}! Seu pedido está PRONTO para retirada! 🎉`,
                done:      `Obrigado ${order.client_name.split(' ')[0]}! Seu pedido foi entregue. Até a próxima! 😊`,
            };
            const waMsg = sc.next ? waMessages[sc.next] : null;
            const waLink = whatsappBase && waMsg ? `${whatsappBase}?text=${encodeURIComponent(waMsg)}` : null;

            const nextBtnHtml = sc.next ? `
                <button class="btn success" onclick="pdvApp.updateWebOrderStatus('${order.id}', '${sc.next}')" style="font-size:0.8rem;padding:6px 12px;">
                    ${sc.nextLabel}
                </button>` : `<span style="color:var(--text-muted);font-size:0.8rem;">✓ Concluído</span>`;

            const waBtnHtml = waLink ? `
                <a href="${waLink}" target="_blank" class="btn" style="font-size:0.8rem;padding:6px 12px;background:rgba(37,211,102,0.15);color:#25D366;border:1px solid rgba(37,211,102,0.3);text-decoration:none;">
                    <i class="fa-brands fa-whatsapp"></i> Avisar
                </a>` : '';

            return `
                <div style="background:var(--surface,var(--bg-card));border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;position:relative;">
                    <!-- Header -->
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px;gap:8px;flex-wrap:wrap;">
                        <div>
                            <div style="font-weight:700;font-size:1rem;">${order.client_name}</div>
                            <div style="font-size:0.82rem;color:var(--text-muted);margin-top:2px;">
                                <i class="fa-solid fa-phone" style="margin-right:4px;"></i>${order.client_phone}
                                &nbsp;·&nbsp;<i class="fa-solid fa-clock" style="margin-right:4px;"></i>${created}
                            </div>
                        </div>
                        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                            <span style="font-size:0.72rem;padding:3px 10px;border-radius:20px;background:${sc.color}22;color:${sc.color};border:1px solid ${sc.color}44;font-weight:600;">${sc.label}</span>
                            <span style="font-size:0.72rem;padding:3px 10px;border-radius:20px;background:${pl.color}22;color:${pl.color};border:1px solid ${pl.color}44;">${pl.text}</span>
                            <span style="font-size:0.72rem;padding:3px 10px;border-radius:20px;background:rgba(255,255,255,0.05);color:var(--text-muted);">${ml}</span>
                        </div>
                    </div>
                    <!-- Itens -->
                    <div style="background:rgba(0,0,0,0.15);border-radius:8px;padding:8px 12px;margin-bottom:10px;">
                        ${itemsHtml}
                        <div style="display:flex;justify-content:space-between;padding:6px 0 0;font-weight:700;">
                            <span>Total</span>
                            <span style="color:var(--primary);">R$ ${Number(order.total).toFixed(2).replace('.', ',')}</span>
                        </div>
                    </div>
                    ${obsHtml}
                    <!-- Ações -->
                    <div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap;">
                        ${nextBtnHtml}
                        ${waBtnHtml}
                    </div>
                </div>`;
        }).join('');
    }

    async function updateWebOrderStatus(orderId, newStatus) {
        try {
            const { error } = await supabase
                .from('web_orders')
                .update({ status: newStatus })
                .eq('id', orderId);
            if (error) throw error;

            // Atualiza localmente
            const idx = webOrders.findIndex(o => o.id === orderId);
            if (idx > -1) webOrders[idx].status = newStatus;

            const statusLabels = { preparing: 'Preparando', ready: 'Pronto', done: 'Entregue' };
            showToast(`Pedido marcado como: ${statusLabels[newStatus] || newStatus}`, 'success');
            renderWebOrders();
            updateWebOrdersBadge();
        } catch(e) {
            showToast('Erro ao atualizar pedido: ' + e.message, 'error');
        }
    }
    // ─────────────────────────────────────────────────────────────────

    // --- Navigation & UI Setup ---

    function setupNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        const views = document.querySelectorAll('.view');

        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const targetId = item.getAttribute('data-target');

                if ((targetId === 'view-pdv' || targetId === 'view-comandas') && !currentFeira) {
                    showCustomAlert('Atenção: Você precisa Abrir o Caixa (na aba Configurações) antes de acessar o PDV!');
                    return;
                }

                // Remove active from all navs
                navItems.forEach(nav => nav.classList.remove('active'));

                // Add active to clicked nav (both desktop and mobile)
                document.querySelectorAll(`[data-target="${targetId}"]`).forEach(n => n.classList.add('active'));

                // Switch views
                views.forEach(view => {
                    view.classList.remove('active');
                    if (view.id === targetId) {
                        view.classList.add('active');
                    }
                });

                // Re-render specifics if needed
                if (targetId === 'view-produtos') renderProductsTable();
                if (targetId === 'view-clientes') renderClientsTable();
                if (targetId === 'view-comandas') renderComandas();
                if (targetId === 'view-dashboard') renderDashboard();
                if (targetId === 'view-config') renderSettings();
                if (targetId === 'view-historico') renderSalesHistory();
            });
        });
    }

    function setupRealTimeClock() {
        const timeEl = document.getElementById('current-time');
        setInterval(() => {
            const now = new Date();
            timeEl.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        }, 1000);
    }

    function setupEventListeners() {
        // PDV Search
        document.getElementById('pdv-search').addEventListener('input', (e) => {
            renderPDVProducts();
        });

        // Dashboard date filters
        const dashStart = document.getElementById('dash-date-start');
        const dashEnd = document.getElementById('dash-date-end');
        if (dashStart) dashStart.addEventListener('change', renderDashboard);
        if (dashEnd) dashEnd.addEventListener('change', renderDashboard);

        // Payment Buttons
        document.querySelectorAll('.payment-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.payment-btn').forEach(b => b.classList.remove('active'));
                const target = e.currentTarget;
                target.classList.add('active');
                currentPaymentMethod = target.getAttribute('data-method');

                const changeGroup = document.getElementById('money-change-group');
                if (currentPaymentMethod === 'Dinheiro') {
                    changeGroup.style.display = 'block';
                } else {
                    changeGroup.style.display = 'none';
                }
            });
        });

        // Change calculation
        const updateCheckoutTotals = () => {
            const receivedStr = document.getElementById('checkout-received').value;
            const received = parseFloat(receivedStr) || 0;
            const discountInput = document.getElementById('checkout-discount');
            const discount = discountInput ? (parseFloat(discountInput.value) || 0) : 0;

            const subtotal = getCartTotal(currentCart);
            const total = Math.max(0, subtotal - discount);
            const change = received - total;

            document.getElementById('checkout-total-value').textContent = formatMoney(total);
            document.getElementById('checkout-change').textContent = formatMoney(change > 0 ? change : 0);
        };

        const checkoutReceivedInput = document.getElementById('checkout-received');
        if (checkoutReceivedInput) checkoutReceivedInput.addEventListener('input', updateCheckoutTotals);

        const checkoutDiscountInput = document.getElementById('checkout-discount');
        if (checkoutDiscountInput) checkoutDiscountInput.addEventListener('input', updateCheckoutTotals);

        const feiranteMethodInput = document.getElementById('feirante-charge-method');
        if (feiranteMethodInput) {
            feiranteMethodInput.addEventListener('change', syncFeiranteChargeFields);
        }

        const feirantePaidInput = document.getElementById('feirante-charge-paid');
        if (feirantePaidInput) {
            feirantePaidInput.addEventListener('input', () => {
                if (getFeiranteChargeMethod() === 'Troca') {
                    feirantePaidInput.value = formatMoney(0);
                    return;
                }
                formatCurrencyInput(feirantePaidInput, false);
            });
            feirantePaidInput.addEventListener('blur', () => {
                if (getFeiranteChargeMethod() === 'Troca') {
                    feirantePaidInput.value = formatMoney(0);
                    return;
                }
                formatCurrencyInput(feirantePaidInput, true);
            });
        }
    }

    // --- Utils ---
    function formatMoney(value) {
        if (typeof value !== 'number' || isNaN(value)) return 'R\$ 0,00';
        return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    /** Round a monetary value to 2 decimal places to avoid IEEE-754 float drift */
    function roundMoney(value) {
        return Math.round((value + Number.EPSILON) * 100) / 100;
    }

    function parseMoneyInput(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? roundMoney(value) : null;

        const rawValue = String(value || '').trim();
        if (!rawValue) return null;

        const sanitized = rawValue
            .replace(/\s/g, '')
            .replace(/^R\$/i, '')
            .replace(/[^\d,.-]/g, '');

        if (!sanitized) return null;

        const lastComma = sanitized.lastIndexOf(',');
        const lastDot = sanitized.lastIndexOf('.');
        let normalizedValue = sanitized;

        if (lastComma > lastDot) {
            normalizedValue = sanitized.replace(/\./g, '').replace(',', '.');
        } else if (lastDot > lastComma) {
            const parts = sanitized.split('.');
            if (parts.length > 2) {
                const decimalPart = parts.pop();
                normalizedValue = `${parts.join('')}.${decimalPart}`;
            }
        }

        const numericValue = Number(normalizedValue);
        return Number.isFinite(numericValue) ? roundMoney(numericValue) : null;
    }

    function formatCurrencyInput(inputEl, forceZeroWhenEmpty) {
        if (!inputEl) return;
        const parsedValue = parseMoneyInput(inputEl.value);
        if (parsedValue === null) {
            inputEl.value = forceZeroWhenEmpty ? formatMoney(0) : '';
            return;
        }
        inputEl.value = formatMoney(parsedValue);
    }

    /** Non-blocking toast notification – replaces showCustomAlert() for I/O errors */
    function showToast(message, type) {
        type = type || 'error';
        let container = document.getElementById('pdv-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'pdv-toast-container';
            container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:340px;';
            document.body.appendChild(container);
        }
        const colors = { error: '#ef4444', success: '#10b981', warning: '#f59e0b', info: '#3b82f6' };
        const icons = { error: 'fa-circle-exclamation', success: 'fa-circle-check', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
        const toast = document.createElement('div');
        toast.style.cssText = `background:rgba(15,15,25,0.97);border:1px solid ${colors[type]};color:#fff;padding:12px 16px;border-radius:8px;font-size:0.9rem;display:flex;align-items:center;gap:10px;box-shadow:0 4px 20px rgba(0,0,0,0.5);animation:fadeInUp 0.2s ease;`;
        toast.innerHTML = `<i class="fa-solid ${icons[type]}" style="color:${colors[type]};flex-shrink:0;"></i><span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.4s'; setTimeout(() => toast.remove(), 400); }, 4000);
    }

    // --- Modal de Novo Pedido Web ---
    function showWebOrderModal(order) {
        // Toca um som de notificação
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.5);
        } catch(e) {}

        // Remove modal anterior se existir
        const old = document.getElementById('web-order-modal');
        if (old) old.remove();

        const items = Array.isArray(order.items) ? order.items : [];
        const itemsHtml = items.map(it => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07);">
                <span><strong>${it.qty}x</strong> ${it.name}</span>
                <span style="color:var(--accent, #f59e0b);">R$ ${Number(it.subtotal || it.price * it.qty).toFixed(2).replace('.', ',')}</span>
            </div>
        `).join('');

        const obsHtml = order.observation ? `<div style="margin-top:10px;padding:8px;background:rgba(245,158,11,0.1);border-left:3px solid #f59e0b;border-radius:4px;font-size:0.85rem;"><i class="fa-solid fa-message-lines" style="color:#f59e0b;margin-right:6px;"></i>${order.observation}</div>` : '';

        const payBadgeColor = order.payment_status === 'approved' ? '#10b981' : order.payment_status === 'pending' ? '#f59e0b' : '#6b7280';
        const payLabel = order.payment_status === 'approved' ? 'Pago' : order.payment_status === 'pending' ? 'Aguardando pagamento' : order.payment_status === 'manual' ? 'Pagamento presencial' : order.payment_status;

        const modal = document.createElement('div');
        modal.id = 'web-order-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);animation:fadeIn 0.2s ease;';
        modal.innerHTML = `
            <div style="background:#1a1a2e;border:1px solid rgba(245,158,11,0.4);border-radius:16px;padding:24px;width:90%;max-width:420px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.7);">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
                    <div style="width:44px;height:44px;border-radius:50%;background:rgba(245,158,11,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        <i class="fa-solid fa-globe" style="color:#f59e0b;font-size:1.2rem;"></i>
                    </div>
                    <div>
                        <div style="font-size:0.75rem;color:#f59e0b;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">Novo Pedido Web 🚀</div>
                        <div style="font-size:1.1rem;font-weight:700;">${order.client_name}</div>
                    </div>
                    <span style="margin-left:auto;font-size:0.72rem;padding:3px 10px;border-radius:20px;background:${payBadgeColor}22;color:${payBadgeColor};border:1px solid ${payBadgeColor}44;">${payLabel}</span>
                </div>

                <div style="font-size:0.85rem;color:#9ca3af;margin-bottom:12px;">
                    <i class="fa-solid fa-phone" style="margin-right:6px;"></i>${order.client_phone}
                </div>

                <div style="font-size:0.8rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Itens do Pedido</div>
                <div style="background:rgba(0,0,0,0.2);border-radius:8px;padding:8px 12px;margin-bottom:12px;">
                    ${itemsHtml || '<span style="color:#6b7280;font-size:0.85rem;">Nenhum item</span>'}
                    <div style="display:flex;justify-content:space-between;padding:8px 0 2px;font-weight:700;font-size:1rem;">
                        <span>Total</span>
                        <span style="color:#f59e0b;">R$ ${Number(order.total).toFixed(2).replace('.', ',')}</span>
                    </div>
                </div>

                ${obsHtml}

                <div style="display:flex;gap:10px;margin-top:16px;">
                    <button id="web-order-dismiss" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#9ca3af;cursor:pointer;font-size:0.9rem;">Dispensar</button>
                    <button id="web-order-accept" style="flex:2;padding:10px;border-radius:8px;border:none;background:#f59e0b;color:#000;cursor:pointer;font-weight:700;font-size:0.9rem;"><i class="fa-solid fa-check" style="margin-right:6px;"></i>Aceitar Pedido</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('#web-order-dismiss').addEventListener('click', () => modal.remove());
        modal.querySelector('#web-order-accept').addEventListener('click', async () => {
            await supabase.from('web_orders').update({ status: 'seen' }).eq('id', order.id);
            showToast(`Pedido de ${order.client_name} aceito!`, 'success');
            modal.remove();
        });
    }

    async function showCancellationModal(order) {
        // Toca um alerta de cancelamento
        try {
            const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
            audio.play().catch(() => {});
        } catch(e){}

        const modal = document.createElement('div');
        modal.className = 'web-order-modal-overlay';
        modal.innerHTML = `
            <div style="background:#1e293b;width:380px;border-radius:16px;padding:24px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);border:1px solid rgba(239, 68, 68, 0.2);animation:slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="display:flex;align-items:center;margin-bottom:16px;">
                    <div style="width:40px;height:40px;border-radius:10px;background:rgba(239, 68, 68, 0.1);display:flex;align-items:center;justify-content:center;color:#ef4444;font-size:1.2rem;margin-right:12px;">
                        <i class="fa-solid fa-triangle-exclamation fa-beat"></i>
                    </div>
                    <div>
                        <h3 style="margin:0;font-size:1.1rem;color:#f8fafc;">Cancelamento Solicitado</h3>
                        <p style="margin:2px 0 0;font-size:0.85rem;color:#9ca3af;">O cliente quer cancelar o pedido #${order.id.slice(-6)}</p>
                    </div>
                </div>

                <div style="font-size:0.9rem;color:#e2e8f0;margin-bottom:12px;background:rgba(0,0,0,0.2);padding:10px;border-radius:8px;">
                    <strong>Cliente:</strong> ${order.client_name}<br>
                    <strong>Valor:</strong> R$ ${Number(order.total).toFixed(2).replace('.', ',')}<br>
                    <strong>Método:</strong> ${order.payment_method === 'bankTransfer' ? 'PIX' : (order.payment_method || 'Cartão')}
                </div>
                
                <p style="font-size:0.85rem;color:#9ca3af;margin-bottom:16px;">
                    Se você aprovar, o pedido será cancelado, o estoque devolvido e o estorno via Mercado Pago será processado automaticamente.
                </p>

                <div style="display:flex;gap:10px;">
                    <button id="btn-refuse-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#f8fafc;cursor:pointer;font-size:0.9rem;">Recusar</button>
                    <button id="btn-approve-cancel" style="flex:1.5;padding:10px;border-radius:8px;border:none;background:#ef4444;color:#fff;cursor:pointer;font-weight:700;font-size:0.9rem;"><i class="fa-solid fa-ban" style="margin-right:6px;"></i>Aprovar e Estornar</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('#btn-refuse-cancel').addEventListener('click', async () => {
            const previousStatus = order.payment_status === 'approved' ? 'pending' : 'waiting_payment';
            await supabase.from('web_orders').update({ status: previousStatus }).eq('id', order.id);
            showToast('Cancelamento recusado. O pedido continua ativo.');
            modal.remove();
        });

        modal.querySelector('#btn-approve-cancel').addEventListener('click', async () => {
            showLoading();
            try {
                // 1. Chamar rota de estorno se foi pago online
                if (order.payment_status === 'approved' && order.payment_method !== 'manual') {
                    const API_BASE_URL = window.location.hostname.includes('netlify.app') ? 'https://pdv-sdzo.onrender.com' : '';
                    const res = await fetch(`${API_BASE_URL}/refund_payment`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ paymentId: order.id })
                    });
                    if (!res.ok) throw new Error('Falha na API de estorno');
                }

                // 2. Devolver o estoque
                const itemsToRestore = (order.items || []).map(it => ({ id: it.productId || it.id, qty: it.qty }));
                if (itemsToRestore.length > 0) {
                    await supabase.rpc('restore_stock_batch', { p_items: itemsToRestore });
                }

                // 3. Atualizar para cancelado e gravar log em observation
                const logMsg = `\n[${new Date().toLocaleString()}] Cancelamento Aprovado e Estornado pelo PDV.`;
                await supabase.from('web_orders').update({ 
                    status: 'cancelled',
                    observation: (order.observation || '') + logMsg
                }).eq('id', order.id);

                showToast('Pedido cancelado e valor estornado com sucesso!', 'success');
                modal.remove();
            } catch (err) {
                console.error(err);
                showToast('Erro ao processar estorno: ' + err.message, 'error');
            } finally {
                hideLoading();
            }
        });
    }

    /** Debounce – coalesces rapid calls into a single deferred call */
    function debounce(fn, wait) {
        let timer = null;
        return function () {
            const ctx = this, args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    function triggerMainDocumentPrint(mode) {
        document.body.classList.remove('printing-receipt', 'printing-report');
        document.body.classList.add(mode === 'report' ? 'printing-report' : 'printing-receipt');

        setTimeout(() => {
            window.print();
        }, 100);
    }

    function printHtmlDocument(title, containerId, containerClass, contentHtml) {
        const textContent = String(contentHtml || '').replace(/<[^>]*>/g, '').trim();
        if (!textContent) {
            showCustomAlert('Não foi possível imprimir: o documento foi gerado sem conteúdo.');
            return false;
        }

        const existingFrame = document.getElementById('pdv-print-frame');
        if (existingFrame) existingFrame.remove();

        const frame = document.createElement('iframe');
        frame.id = 'pdv-print-frame';
        frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0; opacity: 0; pointer-events: none;';
        document.body.appendChild(frame);

        const cleanup = () => {
            if (frame.parentNode) frame.parentNode.removeChild(frame);
        };

        frame.onload = () => {
            const printWindow = frame.contentWindow;
            const printDocument = printWindow ? printWindow.document : null;
            if (!printWindow || !printDocument) {
                cleanup();
                showCustomAlert('Não foi possível iniciar a impressão do documento.');
                return;
            }

            const waitForFonts = printDocument.fonts && typeof printDocument.fonts.ready === 'object'
                ? printDocument.fonts.ready.catch(() => undefined)
                : Promise.resolve();

            waitForFonts.then(() => {
                printWindow.requestAnimationFrame(() => {
                    printWindow.requestAnimationFrame(() => {
                        if (!printDocument.body || !printDocument.body.textContent.trim()) {
                            cleanup();
                            showCustomAlert('Não foi possível imprimir: o conteúdo do documento está vazio.');
                            return;
                        }

                        printWindow.addEventListener('afterprint', cleanup, { once: true });
                        printWindow.focus();
                        printWindow.print();
                    });
                });
            });
        };

        const printDocument = frame.contentWindow.document;
        const inheritedHead = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
            .map(node => node.outerHTML)
            .join('\n');

        printDocument.open();
        printDocument.write(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    ${inheritedHead}
</head>
<body>
    <div id="${containerId}" class="${containerClass}">${contentHtml}</div>
</body>
</html>`);
        printDocument.close();
        return true;
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    function generateSKU() {
        let maxSku = 0;
        db.products.forEach(p => {
            const num = parseInt(p.sku, 10);
            if (!isNaN(num) && num > maxSku) {
                maxSku = num;
            }
        });
        return String(maxSku + 1).padStart(3, '0');
    }

    // --- Render Functions ---
    function renderAll() {
        renderPDVProducts();
        renderPDVCart();
        renderCategories();
        renderDashboard();
        updateRealtimeIndicators();
    }

    function isComandaFiado(c) {
        if (c.paymentMethod) {
            return c.paymentMethod === 'Fiado';
        }
        // Fallback for older data
        if (c.paid) return false;
        if (c.isPageless) return true;
        const relatedSales = db.sales.filter(s => String(s.comanda) === String(c.number) && s.type !== 'canceled');
        const relatedSale = relatedSales.length > 0 ? relatedSales[relatedSales.length - 1] : null;
        return relatedSale && relatedSale.paymentMethod === 'Fiado';
    }

    function buildItemsMatchKey(items) {
        return JSON.stringify((items || []).map(item => ({
            productId: item.productId || '',
            name: item.name || '',
            qty: Number(item.qty || 0),
            price: Number(item.price || 0),
            observation: item.observation || '',
            addons: (item.addons || []).map(addon => ({
                productId: addon.productId || '',
                name: addon.name || '',
                qty: Number(addon.qty || 0),
                price: Number(addon.price || 0)
            }))
        })));
    }

    function datesAreClose(firstDate, secondDate, toleranceMs = 300000) {
        const firstTime = new Date(firstDate || 0).getTime();
        const secondTime = new Date(secondDate || 0).getTime();
        if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) return false;
        return Math.abs(firstTime - secondTime) <= toleranceMs;
    }

    function isMatchingSaleForComanda(sale, comanda) {
        if (!sale || !comanda) return false;
        if (comanda.saleId && String(comanda.saleId) === String(sale.id)) return true;
        if (sale.comanda && String(comanda.number) === String(sale.comanda) && sale.total === comanda.total) return true;

        if (sale.total !== comanda.total) return false;
        if (buildItemsMatchKey(sale.items) !== buildItemsMatchKey(comanda.items)) return false;

        return datesAreClose(sale.date, comanda.date);
    }

    function findLinkedComandaForSale(sale) {
        return [...db.comandas].reverse().find(c => {
            return isMatchingSaleForComanda(sale, c);
        });
    }

    function normalizePaymentMethod(method) {
        if (!method) return '';
        const m = String(method).trim();
        if (m.toUpperCase() === 'PIX') return 'PIX';
        return m;
    }

    function resolveSalePaymentMethod(sale) {
        if (!sale) return '';
        const rawMethod = sale.paymentMethod ? normalizePaymentMethod(sale.paymentMethod) : 'Dinheiro';
        if (rawMethod === 'Fiado') {
            const linkedComanda = findLinkedComandaForSale(sale);
            if (linkedComanda) {
                if (linkedComanda.paid) return 'Fiado Pago';
                if (linkedComanda.status === 'canceled') return 'Cancelado';
                if (linkedComanda.status === 'closed') return 'Fiado Baixado';
            }
            return 'Fiado';
        }
        return rawMethod;
    }

    function isComandaFeirante(c) {
        return c.isFeirante === true;
    }

    function getFeiranteChargeMethod() {
        const methodEl = document.getElementById('feirante-charge-method');
        return methodEl ? methodEl.value : '';
    }

    function syncFeiranteChargeFields() {
        const methodEl = document.getElementById('feirante-charge-method');
        const paidEl = document.getElementById('feirante-charge-paid');
        if (!methodEl || !paidEl) return;

        if (methodEl.value === 'Troca') {
            paidEl.value = formatMoney(0);
            paidEl.disabled = true;
            return;
        }

        paidEl.disabled = false;
        if (!paidEl.value.trim()) {
            paidEl.value = formatMoney(0);
        } else {
            formatCurrencyInput(paidEl, true);
        }
    }

    function openFeiranteChargeModal(comandaId) {
        const comanda = db.comandas.find(item => item.id === comandaId);
        if (!comanda) return;

        pendingFeiranteChargeComandaId = comandaId;
        const isFiado = isComandaFiado(comanda);

        const titleEl = document.getElementById('feirante-charge-title');
        const clientEl = document.getElementById('feirante-charge-client');
        const totalEl = document.getElementById('feirante-charge-total');
        const methodEl = document.getElementById('feirante-charge-method');
        const paidEl = document.getElementById('feirante-charge-paid');

        if (titleEl) titleEl.textContent = isFiado ? `Cobrança Fiado ${comanda.number ? `• Pager ${comanda.number}` : ''}` : `Cobrança Feirante ${comanda.number ? `• Pager ${comanda.number}` : ''}`;
        if (clientEl) clientEl.textContent = comanda.client || (isFiado ? 'Cliente' : 'Feirante');
        if (totalEl) totalEl.textContent = formatMoney(comanda.total || 0);
        if (methodEl) {
            methodEl.value = '';
            const trocaOpt = Array.from(methodEl.options).find(o => o.value === 'Troca');
            if (trocaOpt) {
                trocaOpt.style.display = isFiado ? 'none' : '';
                trocaOpt.disabled = isFiado;
            }
        }
        if (paidEl) {
            paidEl.disabled = false;
            paidEl.value = formatMoney(comanda.total || 0);
        }

        openModal('modal-feirante-charge');
    }

    function closeFeiranteChargeModal() {
        pendingFeiranteChargeComandaId = null;
        closeModal('modal-feirante-charge');
    }

    function getFeiranteChargeData() {
        const methodEl = document.getElementById('feirante-charge-method');
        const paidEl = document.getElementById('feirante-charge-paid');
        return {
            paymentMethod: methodEl ? methodEl.value : '',
            received: parseMoneyInput(paidEl ? paidEl.value : '')
        };
    }

    function validateFeiranteChargeData(chargeData) {
        if (!FEIRANTE_PAYMENT_OPTIONS.includes(chargeData.paymentMethod)) {
            return 'Selecione uma Forma de Pagamento válida para o pedido Feirante.';
        }
        if (chargeData.paymentMethod === 'Troca') {
            if (chargeData.received !== 0) {
                return 'Pagamentos realizados por "Troca" devem obrigatoriamente possuir valor pago igual a R$ 0,00.';
            }
            return null;
        }
        if (chargeData.received === null) {
            return 'O campo Valor Pago é obrigatório para pedidos Feirante.';
        }
        if (chargeData.received < 0) {
            return 'O Valor Pago deve ser maior ou igual a zero.';
        }
        return null;
    }

    async function confirmFeiranteCharge() {
        if (!pendingFeiranteChargeComandaId) return;

        const chargeData = getFeiranteChargeData();
        const validationError = validateFeiranteChargeData(chargeData);
        if (validationError) {
            showCustomAlert(validationError);
            return;
        }

        const paidEl = document.getElementById('feirante-charge-paid');
        if (paidEl) paidEl.value = formatMoney(chargeData.received || 0);

        await payComanda(pendingFeiranteChargeComandaId, chargeData);
    }

    function updateRealtimeIndicators() {
        const physicallyOccupied = db.comandas.filter(c => c.status === 'open' && !c.isPageless).length;
        const totalPagers = 16;
        const freeCount = Math.max(0, totalPagers - physicallyOccupied);

        // FIX: occupiedCount must EXCLUDE delayed comandas so they are not double-counted.
        // Delayed = open + pager + not fiado + not feirante + elapsed > 20 min.
        const now = new Date().getTime();
        const occupiedCount = db.comandas.filter(c => {
            if (c.status !== 'open' || c.isPageless || isComandaFiado(c) || isComandaFeirante(c)) return false;
            const elapsed = now - new Date(c.date || Date.now()).getTime();
            return elapsed <= 1200000; // only "on time" pagers are counted as Occupied
        }).length;
        const feirantesCount = db.comandas.filter(c => c.status === 'open' && isComandaFeirante(c)).length;
        const fiadoCount = db.comandas.filter(c => c.status === 'open' && isComandaFiado(c)).length;
        const delayedCount = db.comandas.filter(c => {
            if (c.status !== 'open' || isComandaFiado(c) || isComandaFeirante(c)) return false;
            return (new Date().getTime() - new Date(c.date || Date.now()).getTime()) > 1200000;
        }).length;

        const elLivres = document.getElementById('ind-livres');
        const elOcupados = document.getElementById('ind-ocupados');
        const elAtraso = document.getElementById('ind-atraso');
        const elFiado = document.getElementById('ind-fiado');
        const elFeirantes = document.getElementById('ind-feirantes');

        if (elLivres) elLivres.textContent = String(freeCount).padStart(2, '0');
        if (elOcupados) elOcupados.textContent = String(occupiedCount).padStart(2, '0');
        if (elAtraso) elAtraso.textContent = String(delayedCount).padStart(2, '0');
        if (elFiado) elFiado.textContent = String(fiadoCount).padStart(2, '0');
        if (elFeirantes) elFeirantes.textContent = String(feirantesCount).padStart(2, '0');

        if (isComandasPanelOpen) {
            renderSideComandasList();
            if (currentSelectedComandaId) {
                showComandaDetail(currentSelectedComandaId);
            }
        }
    }

    // --- Side Panel Logic ---
    function openPagersPanel(filterType) {
        currentPagersFilter = filterType || 'occupied';
        isComandasPanelOpen = true;
        const panel = document.getElementById('side-panel-comandas');
        const title = document.getElementById('side-panel-title');

        if (title) {
            if (filterType === 'free') title.textContent = 'Pagers Livres';
            else if (filterType === 'delayed') title.textContent = 'Pagers em Atraso';
            else if (filterType === 'fiado') title.textContent = 'Contas Fiado';
            else if (filterType === 'feirantes') title.textContent = 'Feirantes';
            else title.textContent = 'Pagers Ocupados';
        }

        if (panel) {
            panel.classList.add('open');
            backToComandasList();
            renderSideComandasList();
        }
    }

    function closePagersPanel() {
        isComandasPanelOpen = false;
        const panel = document.getElementById('side-panel-comandas');
        if (panel) {
            panel.classList.remove('open');
        }
    }

    function backToComandasList() {
        document.getElementById('side-comandas-list').style.display = 'flex';
        document.getElementById('side-comandas-detail').style.display = 'none';
        currentSelectedComandaId = null;
    }

    function renderSideComandasList() {
        const listEl = document.getElementById('side-comandas-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        const occupiedComandas = db.comandas.filter(c => c.status === 'open');

        if (currentPagersFilter === 'free') {
            const occupiedNumbers = occupiedComandas.map(c => c.number);
            const freeNumbers = [];
            for (let i = 1; i <= 16; i++) {
                if (!occupiedNumbers.includes(i)) freeNumbers.push(i);
            }

            if (freeNumbers.length === 0) {
                listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 20px;">Nenhum pager livre no momento.</div>';
                return;
            }

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(80px, 1fr))';
            grid.style.gap = '10px';

            freeNumbers.forEach(n => {
                const el = document.createElement('div');
                el.style.background = 'rgba(16,185,129,0.1)';
                el.style.border = '1px solid var(--success)';
                el.style.borderRadius = 'var(--radius-md)';
                el.style.padding = '15px';
                el.style.textAlign = 'center';
                el.style.color = 'var(--success)';
                el.style.fontWeight = 'bold';
                el.innerHTML = `Pager<br><span style="font-size: 1.5rem;">${String(n).padStart(2, '0')}</span>`;
                grid.appendChild(el);
            });
            listEl.appendChild(grid);
            return;
        }

        const now = new Date().getTime();
        let targetList = occupiedComandas;

        if (currentPagersFilter === 'feirantes') {
            targetList = occupiedComandas.filter(c => isComandaFeirante(c));
        } else if (currentPagersFilter === 'fiado') {
            targetList = occupiedComandas.filter(c => isComandaFiado(c));
        } else if (currentPagersFilter === 'delayed') {
            targetList = occupiedComandas.filter(c => {
                const cTime = new Date(c.date || Date.now()).getTime();
                return (now - cTime) > 1200000 && !isComandaFiado(c) && !isComandaFeirante(c);
            });
        } else {
            // FIX: 'occupied' list must EXCLUDE delayed comandas to prevent duplication.
            // A comanda is "occupied" only if it is on time (<= 20 min elapsed).
            targetList = occupiedComandas.filter(c => {
                if (c.isPageless || isComandaFiado(c) || isComandaFeirante(c)) return false;
                const cTime = new Date(c.date || Date.now()).getTime();
                return (now - cTime) <= 1200000;
            });
        }

        if (targetList.length === 0) {
            let emptyMsg = 'ocupado';
            if (currentPagersFilter === 'delayed') emptyMsg = 'em atraso';
            if (currentPagersFilter === 'fiado') emptyMsg = 'fiado';
            if (currentPagersFilter === 'feirantes') emptyMsg = 'feirante';
            listEl.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-top: 20px;">Nenhum pager ${emptyMsg} no momento.</div>`;
            return;
        }

        targetList.forEach(c => {
            const cTime = new Date(c.date || Date.now()).getTime();
            const elapsedMins = Math.floor((now - cTime) / 60000);

            let statusBadge = c.paid
                ? '<span class="badge" style="background: rgba(16,185,129,0.2); color: var(--success); font-size: 0.75rem;">Pago</span>'
                : '<span class="badge" style="background: rgba(245,158,11,0.2); color: #f59e0b; font-size: 0.75rem;">Pendente</span>';

            let delayHtml = '';
            if (currentPagersFilter === 'delayed') {
                delayHtml = `<div style="color: var(--danger); font-size: 0.85rem; font-weight: bold; margin-top: 5px;"><i class="fa-solid fa-clock"></i> Atrasado há ${elapsedMins} minutos</div>`;
            } else if (elapsedMins > 20 && !c.isPageless) {
                delayHtml = `<div style="color: var(--danger); font-size: 0.85rem; font-weight: bold; margin-top: 5px;"><i class="fa-solid fa-clock"></i> ${elapsedMins} min</div>`;
            } else {
                delayHtml = `<div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 5px;"><i class="fa-solid fa-clock"></i> ${elapsedMins} min</div>`;
            }

            const numberDisplay = c.isPageless ? '<i class="fa-solid fa-book"></i>' : c.number;
            const iconBg = c.isPageless ? '#8b5cf6' : 'var(--primary)';

            let title = c.isPageless ? `Sem Pager - ${c.client}` : `Pager ${String(c.number).padStart(2, '0')}`;
            let subTitle = c.isPageless ? '' : `<div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">${c.client ? 'Cliente: ' + c.client : 'Sem Nome'}</div>`;

            const el = document.createElement('div');
            el.className = 'side-comanda-item';
            if (currentPagersFilter === 'delayed') el.style.borderColor = 'var(--danger)';
            el.onclick = () => showComandaDetail(c.id);
            el.innerHTML = `
                <div style="display: flex; gap: 15px; align-items: center; width: 100%;">
                    <div style="background: ${iconBg}; width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-md); color: white; font-weight: 800; font-size: 1.5rem; flex-shrink: 0;">
                        ${numberDisplay}
                    </div>
                    <div style="flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1; min-width: 0; padding-right: 10px;">
                            <strong style="font-size: 1.1rem; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</strong>
                            ${subTitle}
                            ${delayHtml}
                        </div>
                        <div style="text-align: right; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; flex-shrink: 0;">
                            <div style="font-weight: bold; color: var(--success); margin-bottom: 5px; font-size: 1.1rem;">${formatMoney(c.total)}</div>
                            ${statusBadge}
                        </div>
                    </div>
                </div>
            `;
            listEl.appendChild(el);
        });
    }

    function showComandaDetail(id) {
        const c = db.comandas.find(com => com.id === id);
        if (!c || c.status !== 'open') {
            backToComandasList();
            return;
        }

        currentSelectedComandaId = id;

        document.getElementById('side-comandas-list').style.display = 'none';
        document.getElementById('side-comandas-detail').style.display = 'block';

        document.getElementById('detail-pager-id').textContent = c.isPageless ? `Sem Pager` : `Pager ${String(c.number).padStart(2, '0')}`;

        const statusEl = document.getElementById('detail-pager-status');
        if (c.paid) {
            statusEl.textContent = 'Pago (Pronto para Baixa)';
            statusEl.style.background = 'rgba(16,185,129,0.2)';
            statusEl.style.color = 'var(--success)';
        } else {
            statusEl.textContent = 'Aguardando Pagamento';
            statusEl.style.background = 'rgba(245,158,11,0.2)';
            statusEl.style.color = '#f59e0b';
        }

        document.getElementById('detail-client-name').textContent = c.client || 'Consumidor Final';

        const dObj = new Date(c.date || Date.now());
        document.getElementById('detail-time-opened').textContent = dObj.toLocaleTimeString('pt-BR');

        document.getElementById('detail-total-value').textContent = formatMoney(c.total);

        // Render items
        const itemsList = document.getElementById('detail-items-list');
        itemsList.innerHTML = '';

        c.items.forEach(item => {
            let itemTotal = item.price;
            let addonsHtml = '';
            if (item.addons && item.addons.length > 0) {
                item.addons.forEach(addon => {
                    itemTotal += addon.price * addon.qty;
                    addonsHtml += `<div style="font-size: 0.8rem; color: var(--text-muted); margin-left: 10px;">+ ${addon.qty}x ${addon.name}</div>`;
                });
            }
            let obsHtml = item.observation ? `<div style="font-size: 0.8rem; color: var(--danger); margin-left: 10px; font-style: italic;">Obs: ${item.observation}</div>` : '';

            itemsList.innerHTML += `
                <div style="background: rgba(0,0,0,0.1); padding: 8px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                    <div style="display: flex; justify-content: space-between;">
                        <span style="font-weight: bold; font-size: 0.9rem;">${item.qty}x ${item.name}</span>
                        <span style="color: var(--success); font-size: 0.9rem;">${formatMoney(itemTotal * item.qty)}</span>
                    </div>
                    ${addonsHtml}
                    ${obsHtml}
                </div>
            `;
        });

        // Toggle action buttons
        document.getElementById('btn-cobrar-comanda').style.display = c.paid ? 'none' : 'flex';
        document.getElementById('btn-baixa-comanda').style.display = c.paid ? 'flex' : 'none';
    }

    function chargeSelectedComanda() {
        if (currentSelectedComandaId) {
            payComanda(currentSelectedComandaId);
            // The payComanda logic will trigger renderAll which updates the indicators and re-renders the panel
        }
    }

    function closeSelectedComanda() {
        if (currentSelectedComandaId) {
            darBaixa(currentSelectedComandaId);
        }
    }

    function printSelectedComanda() {
        if (currentSelectedComandaId) {
            reprintComanda(currentSelectedComandaId);
        }
    }

    async function cancelSelectedComanda() {
        if (currentSelectedComandaId) {
            await cancelComandaSale(currentSelectedComandaId);
            backToComandasList();
        }
    }

    function applyDatePreset(preset) {
        const startInput = document.getElementById('dash-date-start');
        const endInput = document.getElementById('dash-date-end');
        const customDiv = document.getElementById('dash-custom-dates');
        if (!startInput || !endInput || !customDiv) return;

        const d = new Date();
        const yyyy_mm_dd = (date) => {
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${date.getFullYear()}-${m}-${day}`;
        };

        let start, end;

        switch (preset) {
            case 'today':
                start = end = d;
                break;
            case 'yesterday':
                const y = new Date(d); y.setDate(y.getDate() - 1);
                start = end = y;
                break;
            case '7days':
                start = new Date(d); start.setDate(start.getDate() - 6);
                end = d;
                break;
            case '30days':
                start = new Date(d); start.setDate(start.getDate() - 29);
                end = d;
                break;
            case 'thisMonth':
                start = new Date(d.getFullYear(), d.getMonth(), 1);
                end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
                break;
            case 'lastMonth':
                start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
                end = new Date(d.getFullYear(), d.getMonth(), 0);
                break;
            case 'custom':
                customDiv.style.display = 'flex';
                return;
        }

        if (preset !== 'custom') {
            customDiv.style.display = 'none';
            startInput.value = yyyy_mm_dd(start);
            endInput.value = yyyy_mm_dd(end);
            renderDashboard();
        }
    }

    async function abrirFeira() {
        const loc = document.getElementById('config-feira-location').value;
        const caixa = parseFloat(document.getElementById('config-feira-caixa').value);
        const obs = document.getElementById('config-feira-obs').value;

        if (!loc) { showCustomAlert('Selecione o local da feira.'); return; }
        if (isNaN(caixa) || caixa <= 0) { showCustomAlert('O Caixa Inicial deve ser maior que zero.'); return; }

        const dateStr = new Date().toISOString().split('T')[0];

        currentFeira = {
            id: 'feira_' + new Date().getTime(),
            location: loc,
            date: dateStr,
            caixaInicial: caixa,
            obs: obs,
            openedAt: new Date().toISOString(),
            status: 'open'
        };
        localStorage.setItem('pdv_current_feira', JSON.stringify(currentFeira));
        await saveFeiraToCloud(currentFeira);
        showCustomAlert('Feira iniciada com sucesso!');
        renderSettings();
        renderDashboard();
    }

    async function encerrarFeira() {
        if (!currentFeira) return;
        if (!(await showCustomConfirm('Deseja realmente encerrar a feira e gerar o relatório?'))) return;

        // FIX: filter by openedAt timestamp (avoids UTC-vs-local-string bug) and
        // exclude canceled originals and cancelamento counter-entries from the totals.
        const feiraStart = new Date(currentFeira.openedAt);
        const feiraSales = db.sales.filter(s =>
            s.feiraLocation === currentFeira.location &&
            new Date(s.date) >= feiraStart
        );

        let totalVendido = 0;
        let totalRecebidoDinheiro = 0;
        let qtdePedidos = 0;
        let qtdeItens = 0;
        let viagemCount = 0;
        let consumoLocalCount = 0;
        let paymentCounts = {};
        let itemsData = {};
        let totalPendencias = 0;

        feiraSales.forEach(sale => {
            // Ignore internal consumption
            if (sale.type === 'consumo') return;
            // FIX: ignore canceled originals and cancelamento counter-entries
            if (sale.type === 'cancelamento') return;
            if (sale.isCanceled) return;

            const pMethod = resolveSalePaymentMethod(sale);
            if (pMethod === 'Cancelado' || pMethod === 'Fiado Baixado') return;

            // Ignora dos totais de venda (Fiado não pago)
            if (pMethod === 'Fiado') {
                totalPendencias = roundMoney(totalPendencias + sale.total);
                return;
            }

            totalVendido = roundMoney(totalVendido + sale.total);
            qtdePedidos++;

            if (pMethod === 'Dinheiro') totalRecebidoDinheiro = roundMoney(totalRecebidoDinheiro + sale.total);
            paymentCounts[pMethod] = roundMoney((paymentCounts[pMethod] || 0) + sale.total);

            if (sale.isViagem) viagemCount++;
            else consumoLocalCount++;

            sale.items.forEach(item => {
                qtdeItens += item.qty;
                if (!itemsData[item.name]) itemsData[item.name] = { qty: 0, rev: 0 };
                itemsData[item.name].qty += item.qty;
                let itemTotal = item.price * item.qty;
                if (item.addons) item.addons.forEach(a => itemTotal += a.price * a.qty * item.qty);
                itemsData[item.name].rev = roundMoney(itemsData[item.name].rev + itemTotal);
            });
        });

        const sortedItems = Object.entries(itemsData).sort((a, b) => b[1].rev - a[1].rev);
        const topItem = sortedItems.length > 0 ? sortedItems[0][0] : 'Nenhum';
        const ticketMedio = qtdePedidos > 0 ? totalVendido / qtdePedidos : 0;
        const valorLiquido = totalVendido;
        const esperadoEmCaixa = currentFeira.caixaInicial + totalRecebidoDinheiro;

        const dateStr = new Date().toLocaleString('pt-BR');

        let reportHtml = `
            <div class="report-print-body">
                <div class="r-brand">
                    <h2 class="r-brand-name">FECHAMENTO FEIRA</h2>
                </div>
                <hr class="r-sep-bold">
                
                <div class="r-section-title">Resumo Geral</div>
                <div class="r-meta"><span>Local:</span> <span>${currentFeira.location}</span></div>
                <div class="r-meta-full">Abertura: ${new Date(currentFeira.openedAt).toLocaleString('pt-BR')}</div>
                <div class="r-meta-full">Fechamento: ${dateStr}</div>
                <div class="r-meta"><span>Caixa Inicial:</span> <span>${formatMoney(currentFeira.caixaInicial)}</span></div>
                <hr class="r-sep">
                <div class="r-total-row"><span>Total Vendido:</span> <span>${formatMoney(totalVendido)}</span></div>
                <hr class="r-sep-bold">

                ${qtdePedidos === 0 ? `
                <div class="r-meta-full" style="text-align: center; font-weight: bold; padding: 8px 0;">Nenhuma movimentação encontrada para o período desta feira.</div>
                <hr class="r-sep-bold">
                ` : ''}

                <div class="r-section-title">Indicadores</div>
                <div class="r-meta"><span>Pedidos:</span> <span>${qtdePedidos}</span></div>
                <div class="r-meta"><span>Itens Vendidos:</span> <span>${qtdeItens}</span></div>
                <div class="r-meta"><span>Ticket Médio:</span> <span>${formatMoney(ticketMedio)}</span></div>
                <div class="r-meta-full" style="font-weight: bold; margin-top: 4px;">Mais Vendido: ${topItem}</div>
                <hr class="r-sep">

                <div class="r-section-title">Tipos de Pedido</div>
                <div class="r-meta"><span>Para Viagem:</span> <span>${viagemCount} (${qtdePedidos > 0 ? Math.round((viagemCount / qtdePedidos) * 100) : 0}%)</span></div>
                <div class="r-meta"><span>No Local:</span> <span>${consumoLocalCount} (${qtdePedidos > 0 ? Math.round((consumoLocalCount / qtdePedidos) * 100) : 0}%)</span></div>
                <hr class="r-sep-bold">

                <div class="r-section-title">Pagamentos</div>
                ${Object.keys(paymentCounts).length === 0 ? `
                    <div class="r-meta-full" style="text-align: center;">Nenhum pagamento registrado no período.</div>
                ` : Object.entries(paymentCounts).map(([method, val]) => `
                    <div class="r-item-header" style="font-size: 12px;">
                        <span class="r-item-name">${method}</span>
                        <span class="r-item-dots"></span>
                        <span class="r-item-price">${formatMoney(val)}</span>
                    </div>
                `).join('')}
                <hr class="r-sep-bold">

                <div class="r-section-title">Controle de Caixa (Físico)</div>
                <div class="r-meta"><span>Caixa Inicial:</span> <span>${formatMoney(currentFeira.caixaInicial)}</span></div>
                <div class="r-meta"><span>Em Dinheiro:</span> <span>${formatMoney(totalRecebidoDinheiro)}</span></div>
                <div class="r-total-row"><span>Esperado no Caixa:</span> <span>${formatMoney(esperadoEmCaixa)}</span></div>
                <hr class="r-sep-bold">

                ${totalPendencias > 0 ? `
                <div class="r-section-title">Valores Pendentes a Receber</div>
                <div class="r-meta"><span>Fiado (Aberto):</span> <span style="font-weight: bold;">${formatMoney(totalPendencias)}</span></div>
                <hr class="r-sep-bold">
                ` : ''}

                <div class="r-section-title">Cancelamentos no Período</div>
                <div class="r-meta"><span>Vendas Canceladas:</span> <span>${feiraSales.filter(s => s.type === 'cancelamento' || s.type === 'canceled').length}</span></div>
                <div class="r-meta"><span>Valor Cancelado:</span> <span>${formatMoney(feiraSales.reduce((sum, s) => sum + (s.type === 'cancelamento' || s.type === 'canceled' ? s.total : 0), 0))}</span></div>
                <hr class="r-sep-bold">

                <div class="r-section-title">Vendas por Produto</div>
                ${sortedItems.length === 0 ? `
                    <div class="r-meta-full" style="text-align: center;">Nenhum item vendido no período.</div>
                ` : sortedItems.map(([name, data]) => `
                    <div class="r-item-header" style="font-size: 12px;">
                        <span class="r-item-name">${data.qty}x ${name}</span>
                        <span class="r-item-dots"></span>
                        <span class="r-item-price">${formatMoney(data.rev)}</span>
                    </div>
                `).join('')}

                ${currentFeira.obs ? `
                    <hr class="r-sep-bold">
                    <div class="r-section-title">Observações</div>
                    <div class="r-meta-full" style="text-align: left; font-style: italic;">${currentFeira.obs}</div>
                ` : ''}

                <hr class="r-sep" style="margin-top: 40px;">
                <div class="r-footer">Assinatura do Responsável</div>
                <div class="r-footer" style="margin-top: 10px;">PDV Offline • Fechamento</div>
            </div>
        `;

        const receiptContainer = document.getElementById('receipt-container');
        const reportContainer = document.getElementById('report-container');
        if (receiptContainer) receiptContainer.innerHTML = '';
        if (reportContainer) reportContainer.innerHTML = reportHtml;
        triggerMainDocumentPrint('report');

        // Finaliza a feira limpando o estado
        currentFeira.closedAt = new Date().toISOString();
        currentFeira.status = 'closed';
        currentFeira.totalVendido = totalVendido;

        await saveFeiraToCloud(currentFeira);

        currentFeira = null;
        localStorage.removeItem('pdv_current_feira');
        renderSettings();
        renderDashboard();
    }

    function renderDashboard() {
        const formatDashValue = (val) => dashboardValuesVisible ? formatMoney(val) : 'R$ •••••';
        const startInput = document.getElementById('dash-date-start');
        const endInput = document.getElementById('dash-date-end');
        const locFilter = document.getElementById('dash-filter-location');

        let startDate = startInput ? startInput.value : null;
        let endDate = endInput ? endInput.value : null;
        let locationFilter = locFilter ? locFilter.value : '';

        // Feira do Dia Banner
        const feiraBanner = document.getElementById('dash-feira-banner');
        const feiraLocationText = document.getElementById('dash-feira-location');
        if (feiraBanner && feiraLocationText) {
            if (currentFeira && currentFeira.location) {
                feiraLocationText.textContent = currentFeira.location;
                feiraBanner.style.display = 'block';
            } else {
                feiraBanner.style.display = 'none';
            }
        }

        const getLocalDateString = () => {
            const d = new Date();
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        // Default to today if empty
        if (!startDate) {
            const todayStr = getLocalDateString();
            if (startInput) startInput.value = todayStr;
            startDate = todayStr;
        }
        if (!endDate) {
            const todayStr = getLocalDateString();
            if (endInput) endInput.value = todayStr;
            endDate = todayStr;
        }

        // Parse dates
        const start = new Date(startDate);
        // Ajuste de fuso: O input 'date' gera a data em UTC meia noite. Adicionando timezone offset.
        start.setMinutes(start.getMinutes() + start.getTimezoneOffset());
        start.setHours(0, 0, 0, 0);

        const end = new Date(endDate);
        end.setMinutes(end.getMinutes() + end.getTimezoneOffset());
        end.setHours(23, 59, 59, 999);

        const filteredSales = db.sales.filter(s => {
            const d = new Date(s.date);
            const inDate = d >= start && d <= end;
            const inLocation = locationFilter ? (s.feiraLocation === locationFilter) : true;
            return inDate && inLocation;
        });

        let totalSales = 0;
        let totalConsumo = 0;
        let totalCancelado = 0;
        let totalPendencias = 0;
        let countForTicket = 0;
        let itemsData = {}; // { name: { qty: 0, revenue: 0 } }
        let hourCounts = {};
        let paymentCounts = {};
        let pendenciasList = [];
        let consumoItemsData = {};
        let consumoSalesList = [];

        filteredSales.forEach(sale => {
            if (sale.type === 'consumo') {
                const saleTotal = getCartTotal(sale.items);
                totalConsumo += saleTotal;
                consumoSalesList.push(sale);

                if (sale.items && Array.isArray(sale.items)) {
                    sale.items.forEach(item => {
                        let itemTotal = item.price * item.qty;
                        let addonsStr = '';
                        if (item.addons && item.addons.length > 0) {
                            addonsStr = item.addons.map(a => `${a.qty}x ${a.name}`).join(', ');
                            item.addons.forEach(addon => {
                                itemTotal += addon.price * addon.qty * item.qty;
                            });
                        }
                        const key = item.name + (addonsStr ? ` (+ ${addonsStr})` : '');
                        if (!consumoItemsData[key]) {
                            consumoItemsData[key] = {
                                name: item.name,
                                addonsStr: addonsStr,
                                qty: 0,
                                totalValue: 0
                            };
                        }
                        consumoItemsData[key].qty += item.qty;
                        consumoItemsData[key].totalValue += itemTotal;
                    });
                }
                return; // Ignora faturamento e ticket médio
            }

            if (sale.type === 'cancelamento') {
                totalCancelado += sale.total;
                return; // Contra-partida. Somente entra em cancelados.
            }

            if (sale.isCanceled || sale.type === 'canceled') {
                if (sale.type === 'canceled') {
                    totalCancelado += sale.total; // Legacy fallback
                }
                return; // Não soma em Vendas do Dia, nem itens, nem ticket
            }

            let pMethod = sale.paymentMethod || 'Dinheiro';
            if (pMethod === 'Fiado') {
                pMethod = resolveSalePaymentMethod(sale);
            }

            if (pMethod === 'Cancelado' || pMethod === 'Fiado Baixado') return;

            if (pMethod === 'Fiado') {
                totalPendencias += sale.total;
                sale.pendingValue = sale.total;
                pendenciasList.push(sale);
                return; // Ignora dos totais de vendas e ticket
            }

            // Venda Efetiva
            totalSales += sale.total;
            countForTicket++;

            paymentCounts[pMethod] = (paymentCounts[pMethod] || 0) + sale.total;

            const saleHour = new Date(sale.date).getHours();
            hourCounts[saleHour] = (hourCounts[saleHour] || 0) + 1;

            sale.items.forEach(item => {
                if (!itemsData[item.name]) itemsData[item.name] = { qty: 0, revenue: 0 };
                itemsData[item.name].qty += item.qty;

                let itemTotal = item.price * item.qty;
                if (item.addons) {
                    item.addons.forEach(addon => {
                        itemTotal += addon.price * addon.qty * item.qty;
                    });
                }
                itemsData[item.name].revenue += itemTotal;
            });
        });

        // Vendas do dia
        const dashVendasDia = document.getElementById('dash-vendas-dia');
        if (dashVendasDia) {
            dashVendasDia.textContent = formatDashValue(totalSales);
            dashVendasDia.parentElement.parentElement.style.cursor = 'pointer';
            dashVendasDia.parentElement.parentElement.onclick = () => {
                if (!dashboardValuesVisible) {
                    showToast('Os valores estão ocultos. Clique no ícone de olho no topo para exibir.', 'warning');
                    return;
                }

                const listEl = document.getElementById('dash-pagamento-list');
                const totalEl = document.getElementById('dash-pagamento-total');
                if (!listEl || !totalEl) return;

                listEl.innerHTML = '';
                let hasSales = false;
                let totalVerify = 0;

                for (let method in paymentCounts) {
                    listEl.innerHTML += `
                        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 10px 15px; border-radius: 8px;">
                            <span style="font-weight: 600;">${method}</span>
                            <span style="color: var(--success); font-weight: bold;">${formatMoney(paymentCounts[method])}</span>
                        </div>
                    `;
                    totalVerify += paymentCounts[method];
                    hasSales = true;
                }

                if (!hasSales) {
                    listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1rem;">Nenhuma venda registrada no período.</div>';
                }

                totalEl.textContent = formatMoney(totalVerify);
                openModal('modal-pagamento-dash');
            };
        }

        // Pendências (Fiado)
        const dashPendencias = document.getElementById('dash-pendencias');
        if (dashPendencias) {
            dashPendencias.textContent = formatDashValue(totalPendencias);
            dashPendencias.parentElement.parentElement.style.cursor = 'pointer';
            dashPendencias.parentElement.parentElement.onclick = () => {
                if (!dashboardValuesVisible) {
                    showToast('Os valores estão ocultos. Clique no ícone de olho no topo para exibir.', 'warning');
                    return;
                }

                const listEl = document.getElementById('dash-pendencias-list');
                const totalEl = document.getElementById('dash-pendencias-total');
                if (!listEl || !totalEl) return;

                listEl.innerHTML = '';
                let hasPendencias = false;

                pendenciasList.forEach(sale => {
                    hasPendencias = true;
                    const pendingClientName = (sale.client || sale.clientName || sale.clientPhone || '').trim() || (sale.isFeirante ? 'Feirante' : 'Cliente');
                    const div = document.createElement('div');
                    div.style.cssText = 'display: flex; justify-content: space-between; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 8px; align-items: center;';
                    div.innerHTML = `
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-weight: bold;">${pendingClientName}</span>
                            <span style="font-size: 0.85rem; color: var(--text-muted);">${new Date(sale.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <span style="font-weight: bold; color: #a78bfa;">${formatMoney(sale.pendingValue || sale.total)}</span>
                    `;
                    listEl.appendChild(div);
                });

                if (!hasPendencias) {
                    listEl.innerHTML = '<div style="padding: 10px; text-align: center; color: var(--text-muted);">Nenhuma pendência encontrada.</div>';
                }

                totalEl.textContent = formatMoney(totalPendencias);
                document.getElementById('modal-pendencias-dash').classList.add('active');
            };
        }

        // Cancelamentos
        const dashCancelado = document.getElementById('dash-cancelado');
        if (dashCancelado) dashCancelado.textContent = formatDashValue(totalCancelado);

        // Consumo Interno
        const dashConsumoInterno = document.getElementById('dash-consumo-interno');
        if (dashConsumoInterno) {
            dashConsumoInterno.textContent = formatDashValue(totalConsumo);
            const consumoCard = dashConsumoInterno.parentElement.parentElement;
            consumoCard.style.cursor = 'pointer';
            consumoCard.onclick = () => {
                if (!dashboardValuesVisible) {
                    showToast('Os valores estão ocultos. Clique no ícone de olho no topo para exibir.', 'warning');
                    return;
                }

                const listEl = document.getElementById('dash-consumo-list');
                const totalEl = document.getElementById('dash-consumo-total');
                if (!listEl || !totalEl) return;

                listEl.innerHTML = '';
                let hasConsumo = false;

                const itemsKeys = Object.keys(consumoItemsData);
                if (itemsKeys.length > 0) {
                    hasConsumo = true;

                    const headerProd = document.createElement('div');
                    headerProd.style.cssText = 'font-weight: 600; font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;';
                    headerProd.innerHTML = '<i class="fa-solid fa-boxes-stacked"></i> Resumo dos Produtos Consumidos';
                    listEl.appendChild(headerProd);

                    const sortedItems = Object.entries(consumoItemsData).sort((a, b) => b[1].qty - a[1].qty);

                    sortedItems.forEach(([key, data]) => {
                        const itemDiv = document.createElement('div');
                        itemDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 10px 15px; border-radius: 8px; margin-bottom: 6px;';
                        itemDiv.innerHTML = `
                            <div style="display: flex; flex-direction: column;">
                                <span style="font-weight: 600;">${data.name}</span>
                                ${data.addonsStr ? `<span style="font-size: 0.8rem; color: var(--text-muted);">${data.addonsStr}</span>` : ''}
                                <span style="font-size: 0.8rem; color: var(--warning); font-weight: 500;">Qtd total: ${data.qty} un.</span>
                            </div>
                            <span style="color: var(--warning); font-weight: bold; font-size: 1rem;">${formatMoney(data.totalValue)}</span>
                        `;
                        listEl.appendChild(itemDiv);
                    });

                    if (consumoSalesList.length > 0) {
                        const headerHist = document.createElement('div');
                        headerHist.style.cssText = 'font-weight: 600; font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 16px; margin-bottom: 6px;';
                        headerHist.innerHTML = `<i class="fa-solid fa-list-check"></i> Histórico de Lançamentos (${consumoSalesList.length})`;
                        listEl.appendChild(headerHist);

                        consumoSalesList.forEach(sale => {
                            const saleTotal = getCartTotal(sale.items);
                            const saleTime = new Date(sale.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            const itemsSummary = (sale.items || []).map(i => `${i.qty}x ${i.name}`).join(', ');

                            const saleDiv = document.createElement('div');
                            saleDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); border: 1px dashed var(--border); padding: 8px 12px; border-radius: 8px; margin-bottom: 6px;';
                            saleDiv.innerHTML = `
                                <div style="display: flex; flex-direction: column; overflow: hidden; padding-right: 8px;">
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        <span style="font-size: 0.8rem; font-weight: bold; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;">${saleTime}</span>
                                        <span style="font-weight: 500; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${itemsSummary}</span>
                                    </div>
                                </div>
                                <span style="font-weight: bold; color: var(--warning); font-size: 0.9rem; white-space: nowrap;">${formatMoney(saleTotal)}</span>
                            `;
                            listEl.appendChild(saleDiv);
                        });
                    }
                }

                if (!hasConsumo) {
                    listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Nenhum consumo de barraca registrado no período.</div>';
                }

                totalEl.textContent = formatMoney(totalConsumo);
                openModal('modal-consumo-dash');
            };
        }

        // Ticket Médio
        const ticketMedio = countForTicket > 0 ? totalSales / countForTicket : 0;
        const dashTicketMedio = document.getElementById('dash-ticket-medio');
        if (dashTicketMedio) dashTicketMedio.textContent = formatDashValue(ticketMedio);

        // Horário de Pico
        let peakHour = '--:--';
        if (Object.keys(hourCounts).length > 0) {
            const bestHour = Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b);
            peakHour = `${String(bestHour).padStart(2, '0')}:00`;
        }
        const dashHorarioPico = document.getElementById('dash-horario-pico');
        if (dashHorarioPico) dashHorarioPico.textContent = dashboardValuesVisible ? peakHour : '••:••';

        // Mais Vendidos / Menos Vendidos
        const sortedByQty = Object.entries(itemsData).sort((a, b) => b[1].qty - a[1].qty);

        const topItemsContainer = document.getElementById('dash-top-items');
        const bottomItemsContainer = document.getElementById('dash-bottom-items');

        if (topItemsContainer && bottomItemsContainer) {
            if (!dashboardValuesVisible) {
                topItemsContainer.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 1rem;"><i class="fa-solid fa-eye-slash"></i> Oculto</li>';
                bottomItemsContainer.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 1rem;"><i class="fa-solid fa-eye-slash"></i> Oculto</li>';
            } else if (sortedByQty.length === 0) {
                topItemsContainer.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 1rem;">Nenhuma venda.</li>';
                bottomItemsContainer.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 1rem;">Nenhuma venda.</li>';
            } else {
                const topItemsData = sortedByQty.slice(0, 3);
                topItemsContainer.innerHTML = topItemsData.map(item => `
                    <li style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 10px 15px; border-radius: 8px; margin-bottom: 10px;">
                        <span class="item-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 10px;">${item[0]}</span>
                        <span class="item-qty" style="background: var(--success); color: white; padding: 0 10px; border-radius: 9999px; font-weight: 800; min-width: 40px; width: auto; height: 26px; font-size: 0.85rem; display: inline-flex; align-items: center; justify-content: center; line-height: 1; flex-shrink: 0; box-sizing: border-box;">${item[1].qty}x</span>
                    </li>
                `).join('');

                const remainingItems = sortedByQty.slice(topItemsData.length);
                const bottomItemsData = remainingItems.slice(-3).reverse();

                if (bottomItemsData.length > 0) {
                    bottomItemsContainer.innerHTML = bottomItemsData.map(item => `
                        <li style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 10px 15px; border-radius: 8px; margin-bottom: 10px;">
                            <span class="item-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 10px;">${item[0]}</span>
                            <span class="item-qty" style="background: var(--danger); color: white; padding: 0 10px; border-radius: 9999px; font-weight: 800; min-width: 40px; width: auto; height: 26px; font-size: 0.85rem; display: inline-flex; align-items: center; justify-content: center; line-height: 1; flex-shrink: 0; box-sizing: border-box;">${item[1].qty}x</span>
                        </li>
                    `).join('');
                } else {
                    bottomItemsContainer.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 1rem;">Nenhum outro item.</li>';
                }
            }
        }



        // --- Curva ABC ---
        const abcContainer = document.getElementById('dash-abc-tbody');
        if (!abcContainer) return;

        if (!dashboardValuesVisible) {
            abcContainer.innerHTML = '<tr><td colspan="5" style="text-align:center;"><i class="fa-solid fa-eye-slash"></i> Oculto</td></tr>';
            return;
        }

        if (totalSales === 0 || sortedByQty.length === 0) {
            abcContainer.innerHTML = '<tr><td colspan="5" style="text-align:center;">Nenhum dado para a Curva ABC no período selecionado.</td></tr>';
            return;
        }

        // Sort by revenue descending
        const sortedByRevenue = Object.entries(itemsData).sort((a, b) => b[1].revenue - a[1].revenue);
        let accumulatedRevenue = 0;

        const abcHtml = sortedByRevenue.map(item => {
            const name = item[0];
            const data = item[1];
            accumulatedRevenue += data.revenue;
            const accumulatedPercentage = (accumulatedRevenue / totalSales) * 100;

            let curveClass = 'badge-c';
            let curveLabel = 'C';
            if (accumulatedPercentage <= 80) {
                curveClass = 'badge-a';
                curveLabel = 'A';
            } else if (accumulatedPercentage <= 95) {
                curveClass = 'badge-b';
                curveLabel = 'B';
            }

            return `
                <tr>
                    <td>${name}</td>
                    <td>${data.qty}</td>
                    <td>${formatDashValue(data.revenue)}</td>
                    <td>${accumulatedPercentage.toFixed(2)}%</td>
                    <td><span class="badge ${curveClass}">${curveLabel}</span></td>
                </tr>
            `;
        }).join('');

        abcContainer.innerHTML = abcHtml;
    }

    function toggleValuesVisibility() {
        dashboardValuesVisible = !dashboardValuesVisible;
        const btn = document.getElementById('toggle-visibility-btn');
        if (btn) {
            btn.innerHTML = dashboardValuesVisible ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
        }
        renderDashboard();
    }

    function updatePDVInsumosAlerts() {
        const indAlert = document.getElementById('ind-insumos-alert');
        const indCount = document.getElementById('ind-insumos-count');
        const modalList = document.getElementById('pdv-insumos-modal-list');

        let count = 0;
        if (modalList) modalList.innerHTML = '';

        db.products.forEach(p => {
            if (!isCategoryActive(p.category)) return;

            const isRaw = p.isRawMaterial || p.category === 'Insumos';
            if (!isRaw && p.isComposed) return;

            const initial = p.initialStock || p.maxStock || (p.stock > 0 ? p.stock : 1);
            if (!p.initialStock) p.initialStock = initial;

            const pct = (p.stock / p.initialStock) * 100;
            let badgeHtml = '';
            let statusColor = 'var(--warning)';

            if (p.stock <= 0) {
                badgeHtml = '<span style="background: rgba(239, 68, 68, 0.2); color: var(--danger); padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.8rem;">⛔ ESGOTADO</span>';
                statusColor = 'var(--danger)';
            } else if (p.stock <= 10) {
                badgeHtml = `<span style="background: rgba(239, 68, 68, 0.15); color: #f87171; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.8rem;">🚨 Crítico (≤ 10un)</span>`;
                statusColor = '#f87171';
            } else if (pct <= 25) {
                badgeHtml = `<span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.8rem;">⚠️ 25% da Qtd</span>`;
                statusColor = '#fbbf24';
            } else if (pct <= 50) {
                badgeHtml = `<span style="background: rgba(245, 158, 11, 0.15); color: var(--warning); padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.8rem;">⚠️ 50% da Qtd</span>`;
                statusColor = 'var(--warning)';
            }

            if (badgeHtml) {
                count++;
                if (modalList) {
                    const itemDiv = document.createElement('div');
                    itemDiv.style.cssText = `display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.25); border-left: 4px solid ${statusColor}; padding: 10px 14px; border-radius: 8px;`;
                    itemDiv.innerHTML = `
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-weight: 600; font-size: 0.95rem;">${p.name}</span>
                            <span style="font-size: 0.8rem; color: var(--text-muted);">Estoque atual: <strong style="color: ${statusColor};">${p.stock} un</strong> ${p.initialStock ? `(de ${p.initialStock} un)` : ''}</span>
                        </div>
                        <div>${badgeHtml}</div>
                    `;
                    modalList.appendChild(itemDiv);
                }
            }
        });

        if (count > 0) {
            if (indCount) indCount.textContent = count;
            if (indAlert) indAlert.style.display = 'inline-flex';
        } else {
            if (indAlert) indAlert.style.display = 'none';
        }
    }

    function openPDVInsumosModal() {
        updatePDVInsumosAlerts();
        openModal('modal-pdv-insumos-alert');
    }

    function renderCategories() {
        // exclude raw material (insumos) from categories
        const sellable = db.products.filter(p => !p.isRawMaterial);
        const allCatNames = [...new Set(sellable.map(p => p.category).filter(Boolean))];
        const activeCategories = allCatNames.filter(c => isCategoryActive(c));
        const categories = ['Todos', ...activeCategories];
        const container = document.getElementById('pdv-categories');
        if (!container) return;
        container.innerHTML = '';

        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = `cat-btn ${cat === 'Todos' ? 'active' : ''}`;
            btn.textContent = cat;
            btn.onclick = (e) => {
                document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                renderPDVProducts();
            };
            container.appendChild(btn);
        });

        // Add Manage Categories button
        const manageBtn = document.createElement('button');
        manageBtn.className = 'cat-btn';
        manageBtn.style.cssText = 'background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: var(--text-muted); padding: 6px 12px; font-size: 0.85rem; border-radius: 20px;';
        manageBtn.innerHTML = '<i class="fa-solid fa-sliders"></i> Categorias';
        manageBtn.title = 'Inativar ou gerenciar categorias';
        manageBtn.onclick = () => openCategoryManagementModal();
        container.appendChild(manageBtn);

        updatePDVInsumosAlerts();
    }

    function getReservedQty(targetProductId) {
        let reserved = 0;
        for (const cartItem of currentCart) {
            // direct cart item
            if (cartItem.productId === targetProductId) reserved += cartItem.qty;
            const cProd = db.products.find(x => x.id === cartItem.productId);
            if (cProd && cProd.isComposed && cProd.composition) {
                const cComp = cProd.composition.find(c => c.productId === targetProductId);
                if (cComp) reserved += cComp.qty * cartItem.qty;
            }

            // Addons
            if (cartItem.addons) {
                for (const addon of cartItem.addons) {
                    if (addon.productId === targetProductId) reserved += addon.qty * cartItem.qty;
                    const aProd = db.products.find(x => x.id === addon.productId);
                    if (aProd && aProd.isComposed && aProd.composition) {
                        const aComp = aProd.composition.find(c => c.productId === targetProductId);
                        if (aComp) reserved += aComp.qty * addon.qty * cartItem.qty;
                    }
                }
            }
        }
        return reserved;
    }

    function getAvailableStock(p) {
        if (p.isRawMaterial) return 0;

        const reserved = getReservedQty(p.id);

        if (!p.isComposed) {
            const disp = p.stock - reserved;
            return disp > 0 ? disp : 0;
        }

        if (!p.composition || p.composition.length === 0) return 999;

        let min = Infinity;
        for (const comp of p.composition) {
            const ing = db.products.find(x => x.id === comp.productId);
            if (!ing) continue;

            const ingReserved = getReservedQty(ing.id);
            const leftForThis = ing.stock - ingReserved;
            const possible = Math.floor(leftForThis / comp.qty);
            if (possible < min) min = possible;
        }
        return min === Infinity ? 0 : (min < 0 ? 0 : min);
    }

    function renderPDVProducts() {
        const grid = document.getElementById('pdv-product-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const searchInput = document.getElementById('pdv-search');
        const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
        const activeCat = document.querySelector('.cat-btn.active');
        const categoryFilter = activeCat && activeCat.textContent !== 'Todos' ? activeCat.textContent : null;

        // Exclude raw materials AND inactive categories from PDV
        let filtered = db.products.filter(p => !p.isRawMaterial && isCategoryActive(p.category));

        if (categoryFilter) {
            filtered = filtered.filter(p => p.category === categoryFilter);
        }

        if (searchTerm) {
            filtered = filtered.filter(p =>
                p.name.toLowerCase().includes(searchTerm) ||
                p.sku.toLowerCase().includes(searchTerm)
            );
        }

        const salesCountMap = {};
        db.sales.forEach(sale => {
            if (sale.items) {
                sale.items.forEach(item => {
                    if (!salesCountMap[item.productId]) salesCountMap[item.productId] = 0;
                    salesCountMap[item.productId] += item.qty;
                });
            }
        });

        filtered.sort((a, b) => {
            const availA = getAvailableStock(a) > 0 ? 1 : 0;
            const availB = getAvailableStock(b) > 0 ? 1 : 0;

            if (availA !== availB) return availB - availA; // Available ones come first

            const salesA = salesCountMap[a.id] || 0;
            const salesB = salesCountMap[b.id] || 0;
            if (salesB !== salesA) return salesB - salesA; // Then most sold

            return (a.name || '').localeCompare(b.name || ''); // Then alphabetical
        });

        filtered.forEach(p => {
            const available = getAvailableStock(p);
            const isOut = available <= 0;
            const stockLabel = p.isComposed
                ? (isOut ? `<span style="color:var(--danger);font-size:0.8rem;">Falta insumo!</span>` : `<span style="color:var(--success);font-size:0.8rem;">Disp: ${available}</span>`)
                : (isOut ? `<span style="color:var(--danger);font-size:0.8rem;">Sem estoque</span>` : `<span style="color:var(--success);font-size:0.8rem;">${available} un</span>`);

            const el = document.createElement('div');
            el.className = `product-card${isOut ? ' out-of-stock' : ''}`;
            if (!isOut) el.onclick = () => addToCart(p.id);
            el.innerHTML = `
                <span class="prod-cat">${p.category}</span>
                <span class="prod-name">${p.name}</span>
                <span class="prod-price">${formatMoney(p.price)}</span>
                <span class="prod-stock">${stockLabel}</span>
            `;
            grid.appendChild(el);
        });

        updatePDVInsumosAlerts();
    }

    function renderPDVCart() {
        const container = document.getElementById('cart-items-container');
        const subtotalEl = document.getElementById('cart-subtotal');
        const totalEl = document.getElementById('cart-total');

        container.innerHTML = '';
        let total = 0;

        if (currentCart.length === 0) {
            container.innerHTML = `
                <div class="empty-cart-msg">
                    <i class="fa-solid fa-cart-arrow-down"></i>
                    <p>O carrinho está vazio</p>
                </div>`;
            subtotalEl.textContent = 'R$ 0,00';
            totalEl.textContent = 'R$ 0,00';
            return;
        }

        currentCart.forEach(item => {
            let itemTotal = item.price;
            let addonsHtml = '';
            if (item.addons && item.addons.length > 0) {
                item.addons.forEach((addon, idx) => {
                    itemTotal += addon.price * addon.qty;
                    addonsHtml += `
                        <div style="font-size: 0.85rem; color: var(--text-main); margin-left: 10px; margin-top: 4px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 5px; background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px;">
                            <span>+ ${addon.name}</span>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <button class="btn secondary" style="padding: 2px 8px; font-size: 0.9rem; border-radius: 4px;" onclick="pdvApp.updateCartItemAddonQty('${item.cartItemId}', '${addon.productId}', -1)">-</button>
                                <span style="font-weight: bold; width: 14px; text-align: center;">${addon.qty}</span>
                                <button class="btn secondary" style="padding: 2px 8px; font-size: 0.9rem; border-radius: 4px;" onclick="pdvApp.updateCartItemAddonQty('${item.cartItemId}', '${addon.productId}', 1)">+</button>
                            </div>
                        </div>
                    `;
                });
            }

            let obsHtml = '';
            if (item.observation) {
                obsHtml = `
                    <div style="font-size: 0.8rem; color: var(--danger); margin-left: 10px; margin-top: 2px; font-style: italic;">
                        Obs: ${item.observation}
                    </div>
                `;
            }

            total = roundMoney(total + itemTotal * item.qty);
            const el = document.createElement('div');
            el.className = 'cart-item';
            el.innerHTML = `
                <div class="item-info">
                    <div class="item-name">${item.name}</div>
                    <div class="item-price">${formatMoney(item.price)} un</div>
                    ${addonsHtml}
                    ${obsHtml}
                </div>
                <div class="item-controls" style="flex-wrap: wrap; justify-content: flex-end; width: 130px;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <button class="qty-btn" onclick="pdvApp.updateCartQty('${item.cartItemId}', -1)">-</button>
                        <span class="item-qty">${item.qty}</span>
                        <button class="qty-btn" onclick="pdvApp.updateCartQty('${item.cartItemId}', 1)">+</button>
                    </div>
                    <span class="item-total" style="width: auto; min-width: 60px;">${formatMoney(itemTotal * item.qty)}</span>
                </div>
            `;
            container.appendChild(el);
        });

        const formattedTotal = formatMoney(total);
        subtotalEl.textContent = formattedTotal;
        totalEl.textContent = formattedTotal;
    }

    // --- Cart Logic ---

    function showStockAlert(product, availableStock) {
        if (product.isRawMaterial || availableStock > 10) return;

        let existingBanner = document.getElementById('stock-alert-banner');
        if (existingBanner) existingBanner.remove();

        const banner = document.createElement('div');
        banner.id = 'stock-alert-banner';
        banner.className = 'stock-alert-banner ' + (availableStock <= 5 ? 'stock-critical' : 'stock-warning');
        banner.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> <span>Atenção: <strong>${product.name}</strong> — Restam apenas <strong>${availableStock}</strong> unidades no estoque!</span>`;

        document.body.appendChild(banner);

        setTimeout(() => {
            const b = document.getElementById('stock-alert-banner');
            if (b) {
                b.classList.add('stock-fade-out');
                setTimeout(() => b.remove(), 400);
            }
        }, 4000);
    }

    function addToCart(productId) {
        const prod = db.products.find(p => p.id === productId);
        if (!prod) return;

        const available = getAvailableStock(prod);
        if (available < 1) {
            showCustomAlert(prod.isComposed ? 'Falta insumo(s) no estoque para produzir este item!' : 'Produto sem estoque!');
            return;
        }

        if (prod.isCustomizable) {
            openCustomizeModal(prod);
            return;
        }

        const existing = currentCart.find(i => i.productId === productId && (!i.addons || i.addons.length === 0) && !i.observation);
        if (existing) {
            existing.qty += 1;
        } else {
            currentCart.push({ cartItemId: generateId(), productId: prod.id, name: prod.name, price: prod.price, qty: 1, addons: [], observation: '' });
        }
        renderPDVCart();
        renderPDVProducts();

        showStockAlert(prod, available - 1);
    }

    function updateCartQty(cartItemId, delta) {
        const itemIndex = currentCart.findIndex(i => i.cartItemId === cartItemId);
        if (itemIndex > -1) {
            const item = currentCart[itemIndex];
            const prod = db.products.find(p => p.id === item.productId);

            const newQty = item.qty + delta;

            if (delta > 0) {
                const available = getAvailableStock(prod);
                if (available < delta) {
                    showCustomAlert(prod.isComposed ? 'Falta insumo(s) no estoque para produzir mais!' : 'Limite de estoque atingido!');
                    return;
                }
                showStockAlert(prod, available - delta);
            }

            item.qty = newQty;

            if (item.qty <= 0) {
                currentCart.splice(itemIndex, 1);
            }
            renderPDVCart();
            renderPDVProducts();
        }
    }
    function updateCartItemAddonQty(cartItemId, addonId, delta) {
        const itemIndex = currentCart.findIndex(i => i.cartItemId === cartItemId);
        if (itemIndex > -1) {
            const item = currentCart[itemIndex];
            const addonIndex = item.addons.findIndex(a => a.productId === addonId);

            if (addonIndex > -1) {
                const addon = item.addons[addonIndex];

                if (delta > 0) {
                    const prod = db.products.find(p => p.id === addonId);
                    if (prod && getAvailableStock(prod) < delta) {
                        showCustomAlert(`Estoque insuficiente para o adicional: ${prod.name}`);
                        return;
                    }
                }

                addon.qty += delta;
                if (addon.qty <= 0) {
                    item.addons.splice(addonIndex, 1);
                }
                renderPDVCart();
            }
        }
    }
    async function clearCart() {
        if (await showCustomConfirm('Deseja limpar o carrinho?')) {
            currentCart = [];
            renderPDVCart();
            renderPDVProducts();
        }
    }

    function getCartTotal(cart) {
        return cart.reduce((sum, item) => {
            let itemTotal = item.price;
            if (item.addons) {
                item.addons.forEach(a => itemTotal += a.price * a.qty);
            }
            return sum + (itemTotal * item.qty);
        }, 0);
    }

    let currentCustomizeAddons = [];
    let currentCustomizeVariations = [];
    let currentCustomizeProduct = null;
    let currentCustomizeQty = 1;

    // --- Customization Options ---
    let VARIATIONS_DONENESS = ['Mal Passado', 'Ao Ponto', 'Bem Passado'];
    let VARIATIONS_INGREDIENTS = ['Sem Vinagrete', 'Sem Maionese', 'Sem Queijo', 'Sem Miolo', 'Completo'];
    let VARIATIONS_EXTRAS = ['Fatiado', 'Com Farofa'];

    function openCustomizeModal(prod) {
        currentCustomizeProduct = prod;
        currentCustomizeAddons = [];
        currentCustomizeVariations = [];

        const isLanche = prod.name.toLowerCase().includes('lanche') || (prod.category && prod.category.toLowerCase().includes('lanche'));
        const isEspeto = prod.name.toLowerCase().includes('espeto') || (prod.category && prod.category.toLowerCase().includes('espeto'));
        if (isLanche) {
            currentCustomizeVariations = ['Completo', 'Ao Ponto'];
        } else if (isEspeto) {
            currentCustomizeVariations = ['Ao Ponto'];
        }

        currentCustomizeQty = 1;

        const qtyEl = document.getElementById('customize-qty');
        if (qtyEl) qtyEl.textContent = currentCustomizeQty;

        document.getElementById('customize-product-id').value = prod.id;
        document.getElementById('customize-product-name').textContent = prod.name;
        document.getElementById('customize-product-price').textContent = formatMoney(prod.price);

        populateAddonSelect();
        renderCustomizeVariations();
        renderCustomizeAddons();
        openModal('modal-customize');
    }

    function populateAddonSelect() {
        const select = document.getElementById('customize-addon-select');
        if (!select) return;
        select.innerHTML = '';

        const availableAddons = db.products.filter(p =>
            !p.isRawMaterial &&
            p.id !== (currentCustomizeProduct ? currentCustomizeProduct.id : null) &&
            (p.name.toLowerCase().includes('espeto') || (p.category && p.category.toLowerCase().includes('espeto')))
        );

        const isLanche = currentCustomizeProduct && (
            currentCustomizeProduct.name.toLowerCase().includes('lanche') ||
            (currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('lanche'))
        );

        if (availableAddons.length === 0) {
            const opt = document.createElement('option');
            opt.value = "";
            opt.textContent = "Nenhum adicional disponível";
            select.appendChild(opt);
            select.disabled = true;
        } else {
            select.disabled = false;
            availableAddons.forEach(prod => {
                const opt = document.createElement('option');
                opt.value = prod.id;
                const finalPrice = isLanche ? Math.max(0, prod.price - 1) : prod.price;
                opt.textContent = `${prod.name} (+${formatMoney(finalPrice)})`;
                select.appendChild(opt);
            });
        }
    }

    function addSelectedAddon() {
        const select = document.getElementById('customize-addon-select');
        if (!select || !select.value) return;

        pdvApp.updateCustomizeAddonQty(select.value, 1);
    }

    function renderCustomizeVariations() {
        const isEspeto = currentCustomizeProduct && (
            currentCustomizeProduct.name.toLowerCase().includes('espeto') ||
            (currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('espeto'))
        );
        const isLanche = currentCustomizeProduct && (
            currentCustomizeProduct.name.toLowerCase().includes('lanche') ||
            (currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('lanche'))
        );

        // Adicionais: apenas para lanches
        const addonsContainer = document.getElementById('customize-addons-container');
        if (addonsContainer) {
            addonsContainer.style.display = isLanche ? 'block' : 'none';
        }

        // Ingredientes: apenas para lanches
        const ingredientsContainer = document.getElementById('customize-ingredients-container');
        if (ingredientsContainer) {
            ingredientsContainer.style.display = isLanche ? 'block' : 'none';
        }

        const ingredientsList = document.getElementById('customize-variations-ingredients-list');
        if (ingredientsList && isLanche) {
            ingredientsList.innerHTML = '';
            VARIATIONS_INGREDIENTS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `var-btn ${isSelected ? 'selected' : ''}`;
                btn.textContent = vari;
                btn.onclick = () => pdvApp.toggleVariation(vari);
                ingredientsList.appendChild(btn);
            });
        }

        // Ponto da Carne: aparece para todos
        const donenessList = document.getElementById('customize-variations-doneness-list');
        if (donenessList) {
            donenessList.innerHTML = '';
            VARIATIONS_DONENESS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `var-btn ${isSelected ? 'selected' : ''}`;
                btn.textContent = vari;
                btn.onclick = () => pdvApp.toggleVariation(vari);
                donenessList.appendChild(btn);
            });
        }

        // Extras: apenas para espetos
        const extrasContainer = document.getElementById('customize-extras-container');
        if (extrasContainer) {
            extrasContainer.style.display = isEspeto ? 'block' : 'none';
        }

        const extrasList = document.getElementById('customize-variations-extras-list');
        if (extrasList && isEspeto) {
            extrasList.innerHTML = '';
            VARIATIONS_EXTRAS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `var-btn ${isSelected ? 'selected' : ''}`;
                btn.textContent = vari;
                btn.onclick = () => pdvApp.toggleVariation(vari);
                extrasList.appendChild(btn);
            });
        }
    }

    function toggleVariation(vari) {
        const isCurrentlySelected = currentCustomizeVariations.includes(vari);

        if (VARIATIONS_DONENESS.includes(vari)) {
            // Ponto da carne: single selection
            currentCustomizeVariations = currentCustomizeVariations.filter(v => !VARIATIONS_DONENESS.includes(v));
            if (!isCurrentlySelected) currentCustomizeVariations.push(vari);
        } else if (VARIATIONS_INGREDIENTS.includes(vari)) {
            // Ingredientes de Lanche: mutually exclusive (Completo vs Sem...)
            if (vari === 'Completo') {
                if (!isCurrentlySelected) {
                    currentCustomizeVariations = currentCustomizeVariations.filter(v => !VARIATIONS_INGREDIENTS.includes(v));
                    currentCustomizeVariations.push('Completo');
                } else {
                    currentCustomizeVariations = currentCustomizeVariations.filter(v => v !== 'Completo');
                }
            } else {
                if (!isCurrentlySelected) {
                    currentCustomizeVariations = currentCustomizeVariations.filter(v => v !== 'Completo');
                    currentCustomizeVariations.push(vari);
                } else {
                    currentCustomizeVariations = currentCustomizeVariations.filter(v => v !== vari);
                }
            }
        } else {
            // Extras (Fatiado, Farofa): normal toggle
            if (isCurrentlySelected) {
                currentCustomizeVariations = currentCustomizeVariations.filter(v => v !== vari);
            } else {
                currentCustomizeVariations.push(vari);
            }
        }

        renderCustomizeVariations();
    }

    function updateCustomizeAddonQty(productId, delta) {
        const prod = db.products.find(p => p.id === productId);
        if (!prod) return;

        let addon = currentCustomizeAddons.find(a => a.productId === productId);

        if (!addon) {
            if (delta > 0) {
                const isLanche = currentCustomizeProduct && (
                    currentCustomizeProduct.name.toLowerCase().includes('lanche') ||
                    (currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('lanche'))
                );
                const finalPrice = isLanche ? Math.max(0, prod.price - 1) : prod.price;

                currentCustomizeAddons.push({
                    productId: prod.id,
                    name: prod.name,
                    price: finalPrice,
                    qty: delta
                });
            }
        } else {
            addon.qty += delta;
            if (addon.qty <= 0) {
                currentCustomizeAddons = currentCustomizeAddons.filter(a => a.productId !== productId);
            }
        }
        renderCustomizeAddons();
    }

    function renderCustomizeAddons() {
        const list = document.getElementById('customize-addons-list');
        if (!list) return;
        list.innerHTML = '';
        let total = currentCustomizeProduct ? currentCustomizeProduct.price : 0;

        if (currentCustomizeAddons.length === 0) {
            list.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; text-align: center; margin: 10px 0;">Nenhum adicional selecionado</p>';
        }

        currentCustomizeAddons.forEach(addon => {
            total += (addon.price * addon.qty);

            const el = document.createElement('div');
            el.style = "font-size: 0.95rem; background: rgba(0,0,0,0.2); border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;";

            const namePriceDiv = document.createElement('div');
            namePriceDiv.innerHTML = `<strong>${addon.name}</strong> <span style="color: var(--text-muted); font-size: 0.85rem;">(+${formatMoney(addon.price)})</span>`;

            const actionsDiv = document.createElement('div');
            actionsDiv.style = "display: flex; align-items: center; gap: 8px;";

            const btnMinus = document.createElement('button');
            btnMinus.className = 'btn secondary';
            btnMinus.style = "padding: 2px 10px; font-size: 1.1rem; border-radius: 4px;";
            btnMinus.textContent = '-';
            btnMinus.onclick = () => pdvApp.updateCustomizeAddonQty(addon.productId, -1);

            const spanQty = document.createElement('span');
            spanQty.style = "width: 20px; text-align: center; font-weight: bold;";
            spanQty.textContent = addon.qty;

            const btnPlus = document.createElement('button');
            btnPlus.className = 'btn secondary';
            btnPlus.style = "padding: 2px 10px; font-size: 1.1rem; border-radius: 4px;";
            btnPlus.textContent = '+';
            btnPlus.onclick = () => pdvApp.updateCustomizeAddonQty(addon.productId, 1);

            actionsDiv.appendChild(btnMinus);
            actionsDiv.appendChild(spanQty);
            actionsDiv.appendChild(btnPlus);

            el.appendChild(namePriceDiv);
            el.appendChild(actionsDiv);
            list.appendChild(el);
        });

        document.getElementById('customize-total').textContent = formatMoney(total * currentCustomizeQty);
    }

    function updateCustomizeQty(delta) {
        currentCustomizeQty += delta;
        if (currentCustomizeQty < 1) currentCustomizeQty = 1;

        const qtyEl = document.getElementById('customize-qty');
        if (qtyEl) qtyEl.textContent = currentCustomizeQty;

        renderCustomizeAddons();
    }

    function confirmCustomization() {
        if (!currentCustomizeProduct) return;

        let hasError = false;

        const mainProd = db.products.find(x => x.id === currentCustomizeProduct.id);
        if (mainProd && getAvailableStock(mainProd) < currentCustomizeQty) {
            showCustomAlert(mainProd.isComposed ? 'Falta insumo(s) no estoque para produzir esta quantidade!' : 'Estoque insuficiente!');
            return;
        }

        currentCustomizeAddons.forEach(a => {
            const p = db.products.find(x => x.id === a.productId);
            if (p && getAvailableStock(p) < (a.qty * currentCustomizeQty)) {
                showCustomAlert(`Estoque insuficiente para o adicional: ${p.name}`);
                hasError = true;
            }
        });
        if (hasError) return;

        const obs = currentCustomizeVariations.length > 0 ? currentCustomizeVariations.join(' | ') : '';

        const existingItemIndex = currentCart.findIndex(item => {
            if (item.productId !== currentCustomizeProduct.id) return false;
            if (item.observation !== obs) return false;
            if ((!item.addons || item.addons.length === 0) && currentCustomizeAddons.length > 0) return false;
            if (item.addons && item.addons.length > 0 && currentCustomizeAddons.length === 0) return false;
            if (item.addons && currentCustomizeAddons) {
                if (item.addons.length !== currentCustomizeAddons.length) return false;
                const add1 = item.addons.map(a => `${a.productId}:${a.qty}`).sort().join('|');
                const add2 = currentCustomizeAddons.map(a => `${a.productId}:${a.qty}`).sort().join('|');
                if (add1 !== add2) return false;
            }
            return true;
        });

        if (existingItemIndex > -1) {
            currentCart[existingItemIndex].qty += currentCustomizeQty;
        } else {
            currentCart.push({
                cartItemId: generateId(),
                productId: currentCustomizeProduct.id,
                name: currentCustomizeProduct.name,
                price: currentCustomizeProduct.price,
                qty: currentCustomizeQty,
                addons: currentCustomizeAddons.map(a => ({ ...a })),
                observation: obs
            });
        }

        renderPDVCart();
        renderPDVProducts();
        closeModal('modal-customize');

        if (mainProd) {
            const available = getAvailableStock(mainProd);
            const totalQtyInCart = currentCart.reduce((sum, item) => {
                return item.productId === currentCustomizeProduct.id ? sum + item.qty : sum;
            }, 0);
            // Stock deduction has NOT happened yet in the DB, so we don't subtract from `available` here,
            // or we manually subtract what is in the cart. Actually, available is based on db.products.stock
            // minus what is in currentCart (getReservedQty). So `getAvailableStock` ALREADY subtracts the cart amount!
            // Wait, getReservedQty subtracts the cart amount.
            // So `available` is the remaining stock AFTER the item is added to the cart!
            showStockAlert(mainProd, available);
        }
    }

    // --- Checkout ---
    function openCheckoutModal() {
        if (currentCart.length === 0) {
            showCustomAlert('O carrinho está vazio!');
            return;
        }
        const total = getCartTotal(currentCart);
        document.getElementById('checkout-total-value').textContent = formatMoney(total);
        document.getElementById('checkout-received').value = '';
        const checkoutDiscount = document.getElementById('checkout-discount');
        if (checkoutDiscount) checkoutDiscount.value = '';
        document.getElementById('checkout-change').textContent = 'R$ 0,00';

        document.getElementById('checkout-comanda').value = '';
        const pagerGrid = document.getElementById('checkout-pager-grid');
        pagerGrid.innerHTML = '';

        for (let i = 1; i <= 16; i++) {
            const isOccupied = db.comandas.some(c => String(c.number) === i.toString() && c.status === 'open');
            const btn = document.createElement('button');
            btn.className = 'pager-btn';
            btn.type = 'button';
            btn.textContent = i;

            if (isOccupied) {
                btn.disabled = true;
                btn.title = 'Ocupado';
            } else {
                btn.onclick = () => {
                    const hiddenInput = document.getElementById('checkout-comanda');
                    if (hiddenInput.value === i.toString()) {
                        btn.classList.remove('selected');
                        hiddenInput.value = '';
                    } else {
                        document.querySelectorAll('.pager-btn').forEach(b => b.classList.remove('selected'));
                        btn.classList.add('selected');
                        hiddenInput.value = i.toString();
                    }
                };
            }
            pagerGrid.appendChild(btn);
        }

        document.getElementById('checkout-cliente').value = '';
        document.getElementById('checkout-viagem').checked = false;
        const feiranteCheckbox = document.getElementById('checkout-feirante');
        if (feiranteCheckbox) feiranteCheckbox.checked = false;

        // Reset payment to cash
        document.querySelectorAll('.payment-btn')[0].click();

        openModal('modal-checkout');
    }

    function deductStockForItem(cartItem) {
        deduct(cartItem.productId, cartItem.qty);
        if (cartItem.addons) {
            cartItem.addons.forEach(addon => {
                deduct(addon.productId, addon.qty * cartItem.qty);
            });
        }
    }

    function checkInsumoStockAlert(prod) {
        if (!prod) return;
        
        // Baseline initial stock reference
        if (!prod.initialStock || prod.stock > prod.initialStock) {
            prod.initialStock = Math.max(prod.stock, 1);
        }

        const initial = prod.initialStock;
        const pct = (prod.stock / initial) * 100;

        let alertLevel = null;
        let alertMsg = '';
        let alertType = 'warning';

        if (prod.stock <= 0) {
            alertLevel = '0un';
            alertMsg = `🚨 ESGOTADO! O insumo/produto "${prod.name}" acabou no estoque (0 un)!`;
            alertType = 'error';
        } else if (prod.stock <= 10) {
            alertLevel = '10un';
            alertMsg = `⚠️ ALERTA DE ESTOQUE: "${prod.name}" restam apenas ${prod.stock} unidade(s)!`;
            alertType = 'warning';
        } else if (pct <= 25) {
            alertLevel = '25pct';
            alertMsg = `⚠️ ALERTA DE ESTOQUE: "${prod.name}" atingiu 25% da quantidade (${prod.stock} un restantes)!`;
            alertType = 'warning';
        } else if (pct <= 50) {
            alertLevel = '50pct';
            alertMsg = `⚠️ ALERTA DE ESTOQUE: "${prod.name}" atingiu 50% da quantidade (${prod.stock} un restantes)!`;
            alertType = 'warning';
        }

        if (alertLevel && prod.lastAlertLevel !== alertLevel) {
            prod.lastAlertLevel = alertLevel;
            showToast(alertMsg, alertType);
        } else if (!alertLevel) {
            prod.lastAlertLevel = null;
        }
    }

    function deduct(productId, qtyToDeduct) {
        const prod = db.products.find(p => p.id === productId);
        if (!prod) return;
        if (prod.isComposed && prod.composition) {
            prod.composition.forEach(comp => {
                const ing = db.products.find(p => p.id === comp.productId);
                if (ing && !ing.isComposed) {
                    if (!ing.initialStock || ing.stock > ing.initialStock) {
                        ing.initialStock = Math.max(ing.stock, 1);
                    }
                    ing.stock -= (comp.qty * qtyToDeduct);
                    saveProductToCloud(ing);
                    checkInsumoStockAlert(ing);
                }
            });
        } else if (!prod.isComposed) {
            if (!prod.initialStock || prod.stock > prod.initialStock) {
                prod.initialStock = Math.max(prod.stock, 1);
            }
            prod.stock -= qtyToDeduct;
            saveProductToCloud(prod);
            checkInsumoStockAlert(prod);
        }
    }

    async function finishConsumo() {
        if (currentCart.length === 0) return;
        if (!(await showCustomConfirm('Registrar esses itens como Consumo Interno da Barraca? (O valor será zerado e não entrará no faturamento)'))) return;

        // Decrease stock
        currentCart.forEach(cartItem => deductStockForItem(cartItem));

        const newSale = {
            id: generateId(),
            seq: db.sales.length + 1,
            date: new Date().toISOString(),
            items: [...currentCart],
            subtotal: 0,
            discount: 0,
            total: 0,
            paymentMethod: 'N/A',
            comanda: '',
            client: 'Consumo Interno',
            isViagem: false,
            type: 'consumo',
            feiraLocation: currentFeira ? currentFeira.location : '',
            updatedAt: new Date().getTime()
        };
        db.sales.push(newSale);

        saveDataLocal();
        saveSaleToCloud(newSale);

        closeModal('modal-checkout');
        currentCart = [];
        renderAll();
        showCustomAlert('Consumo registrado com sucesso!');
    }

    // Processing lock – prevents double-click from creating duplicate sales
    let _isSaleInProgress = false;

    async function finishSale() {
        if (currentCart.length === 0) return;
        if (_isSaleInProgress) return; // Guard: ignore re-entrant calls
        
        // --- Activate processing lock ---
        _isSaleInProgress = true;

        if (!currentFeira) {
            showCustomAlert('Atenção: Você precisa abrir o caixa (Configurações) antes de registrar vendas!');
            _isSaleInProgress = false;
            return;
        }

        let comandaNumber = document.getElementById('checkout-comanda').value;
        const clientName = document.getElementById('checkout-cliente').value;
        const isViagem = document.getElementById('checkout-viagem').checked;
        const isFeirante = document.getElementById('checkout-feirante') ? document.getElementById('checkout-feirante').checked : false;
        let isPageless = false;

        if (!currentPaymentMethod) {
            showCustomAlert('Atenção: É obrigatório selecionar uma forma de pagamento.');
            _isSaleInProgress = false;
            return;
        }

        if (isFeirante && !clientName.trim()) {
            showCustomAlert('Para vendas classificadas como Feirantes, o Nome do cliente é obrigatório.');
            _isSaleInProgress = false;
            return;
        }

        if (currentPaymentMethod === 'Fiado') {
            if (!clientName.trim()) {
                showCustomAlert('Para vendas no Fiado, é obrigatório informar o nome do cliente.');
                _isSaleInProgress = false;
                return;
            }
            if (!comandaNumber.trim()) {
                comandaNumber = 'SP-' + generateId().substring(0, 5).toUpperCase();
                isPageless = true;
            } else {
                isPageless = false;
            }
        } else if (!comandaNumber.trim()) {
            if (isFeirante) {
                comandaNumber = 'SP-' + generateId().substring(0, 5).toUpperCase();
                isPageless = true;
            } else {
                const proceed = await showCustomConfirm('Deseja continuar sem atribuir um pager?');
                if (!proceed) {
                    _isSaleInProgress = false;
                    return;
                }
                if (!clientName.trim()) {
                    showCustomAlert('O preenchimento do nome do cliente é OBRIGATÓRIO quando não há pager.');
                    _isSaleInProgress = false;
                    return;
                }
                comandaNumber = 'SP-' + generateId().substring(0, 5).toUpperCase();
                isPageless = true;
            }
        } else {
            // Validate pager locally
            const isOccupied = db.comandas.some(c => String(c.number) === String(comandaNumber) && c.status === 'open');
            if (isOccupied) {
                showCustomAlert('Este pager já está em uso e não pode ser atribuído novamente até ser liberado.');
                _isSaleInProgress = false;
                return;
            }
            // Validate pager in backend
            const { data: existingComandas, error } = await supabase
                .from('comandas')
                .select('id')
                .eq('number', comandaNumber)
                .eq('status', 'open');

            if (error) {
                showCustomAlert('Erro ao verificar disponibilidade do pager.');
                _isSaleInProgress = false;
                return;
            }
            if (existingComandas && existingComandas.length > 0) {
                showCustomAlert('Este pager já está em uso e não pode ser atribuído novamente até ser liberado.');
                // Atualizar o estado local caso esteja defasado
                await loadData();
                renderAll();
                _isSaleInProgress = false;
                return;
            }
        }

        try {
            // Decrease stock
            currentCart.forEach(cartItem => deductStockForItem(cartItem));

            // Save Sale – use roundMoney to prevent float drift
            const subtotal = roundMoney(getCartTotal(currentCart));
            const discountInput = document.getElementById('checkout-discount');
            // FIX: cap discount so it never exceeds the subtotal
            const discountRaw = discountInput ? (parseFloat(discountInput.value) || 0) : 0;
            const discount = roundMoney(Math.min(discountRaw, subtotal));
            const total = roundMoney(Math.max(0, subtotal - discount));

            // Generate saleId first so comanda can reference it
            const saleId = generateId();

            const newSale = {
                id: saleId,
                seq: db.sales.length + 1,
                date: new Date().toISOString(),
                items: [...currentCart],
                subtotal: subtotal,
                discount: discount,
                total: total,
                paymentMethod: currentPaymentMethod,
                comanda: isPageless ? '' : comandaNumber,
                client: clientName,
                isViagem: isViagem,
                isFeirante: isFeirante,
                type: 'venda',
                feiraLocation: currentFeira ? currentFeira.location : '',
                updatedAt: new Date().getTime()
            };
            db.sales.push(newSale);

            if (comandaNumber) {
                const newComanda = {
                    id: generateId(),
                    number: isPageless ? '' : comandaNumber,
                    isPageless: isPageless,
                    status: 'open',
                    date: new Date().toISOString(),
                    items: [...currentCart],
                    subtotal: subtotal,
                    discount: discount,
                    total: total,
                    client: clientName,
                    isViagem: isViagem,
                    paid: currentPaymentMethod !== 'Fiado',
                    paymentMethod: currentPaymentMethod,
                    isFeirante: isFeirante,
                    saleId: saleId, // FIX: link to sale for reliable cancellation
                    updatedAt: new Date().getTime()
                };
                db.comandas.push(newComanda);

                // Save paid status locally
                let localComandaStatus = JSON.parse(localStorage.getItem('pdv_comanda_status')) || {};
                localComandaStatus[newComanda.id] = newComanda.paid;
                localStorage.setItem('pdv_comanda_status', JSON.stringify(localComandaStatus));

                saveComandaToCloud(newComanda);
            }

            saveDataLocal(); // Backup local

            saveSaleToCloud(newSale); // Envia silenciosamente

            closeModal('modal-checkout');
            currentCart = [];
            renderAll();

            // Imprimir recibo
            printReceipt(newSale);
        } finally {
            // Always release the lock, even if an unexpected error occurs
            _isSaleInProgress = false;
        }
    }

    function printReceipt(sale) {
        const reportContainer = document.getElementById('report-container');
        if (reportContainer) reportContainer.innerHTML = '';
        const container = document.getElementById('receipt-container');
        if (!container) {
            showCustomAlert('Não foi possível localizar o container de impressão do recibo.');
            return;
        }

        let itemsHtml = '';

        sale.items.forEach(item => {
            let itemTotal = item.price;
            let addonsHtml = '';
            if (item.addons && item.addons.length > 0) {
                item.addons.forEach(addon => {
                    itemTotal += addon.price * addon.qty;
                    addonsHtml += `<div class="r-addon" style="font-weight: 900; font-size: 13px; color: #000; margin-top: 2px;">&nbsp;&nbsp;&nbsp;&nbsp;|+ ${addon.qty}X ${addon.name.toUpperCase()}</div>`;
                });
            }

            let obsHtml = '';
            if (item.observation) {
                const tags = item.observation.split(' | ').map(t => `<div class="r-obs-tag" style="font-weight: bold; font-size: 12px; margin-top: 2px;">&nbsp;&nbsp;&nbsp;&nbsp;|- ${t.toUpperCase()}</div>`).join('');
                obsHtml = `<div class="r-obs">${tags}</div>`;
            }

            itemsHtml += `
                <div class="r-item">
                    <div class="r-item-header">
                        <span class="r-item-name" style="text-transform: uppercase;">${item.qty}X ${item.name}</span>
                        <span class="r-item-dots"></span>
                        <span class="r-item-price">${formatMoney(itemTotal * item.qty)}</span>
                    </div>
                    ${addonsHtml}
                    ${obsHtml}
                </div>
            `;
        });

        const dateObj = new Date(sale.date);
        const dateStr = dateObj.toLocaleDateString('pt-BR');
        const timeStr = dateObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const seqNumber = String(sale.seq || db.sales.length).padStart(4, '0');
        const clientName = sale.client || 'Consumidor Final';
        const linkedComanda = sale.comanda ? null : findLinkedComandaForSale(sale);
        const receiptPager = sale.comanda || (linkedComanda && linkedComanda.number ? String(linkedComanda.number) : '');

        container.innerHTML = `
            <div class="r-brand">
                <div class="r-brand-name">Edu Espetinhos</div>
            </div>

            ${receiptPager ? `<div class="r-pager">PAGER ${receiptPager}</div>` : ''}
            ${sale.isViagem ? `<div class="r-viagem">★ Para Viagem ★</div>` : ''}

            <div class="r-pedido">Pedido #${seqNumber}</div>

            <hr class="r-sep">

            <div class="r-meta">
                <span>${clientName}</span>
                <span>${dateStr} ${timeStr}</span>
            </div>

            <hr class="r-sep-bold">

            <div class="r-section-title">Itens</div>
            ${itemsHtml}

            <hr class="r-sep-bold">

            <div class="r-total-row" style="font-size: 16px;">
                <span>TOTAL</span>
                <span>${formatMoney(sale.total)}</span>
            </div>
            
            <div class="r-total-row" style="margin-top: 5px; font-size: 14px;">
                <span>PAGAMENTO</span>
                <span>${sale.paymentMethod}</span>
            </div>

            <hr class="r-sep">

            <div class="r-footer">
                <div class="r-footer-thanks">Obrigado pela preferência!</div>
                <div>Volte sempre</div>
                <div class="r-footer-id">#${sale.id.substring(0, 6).toUpperCase()}</div>
            </div>
        `;

        triggerMainDocumentPrint('receipt');
    }

    // --- Modals ---
    function openModal(id) {
        document.getElementById(id).classList.add('active');
    }

    function closeModal(id) {
        document.getElementById(id).classList.remove('active');
    }

    // --- Products Management ---
    function renderProductsTable() {
        const tbody = document.getElementById('products-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const searchInput = document.getElementById('prod-filter-search');
        const search = searchInput ? searchInput.value.toLowerCase() : '';
        const catSelect = document.getElementById('prod-filter-category');
        const category = catSelect ? catSelect.value : '';
        const sortSelect = document.getElementById('prod-filter-sort');
        const sort = sortSelect ? sortSelect.value : 'best_sellers';

        // Atualiza as categorias dinamicamente
        if (catSelect) {
            const currentCat = catSelect.value;
            const categories = [...new Set(db.products.map(p => p.isRawMaterial ? 'Insumo' : p.category).filter(Boolean))];
            catSelect.innerHTML = '<option value="" style="color: black;">Todas as Categorias</option>';
            categories.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                opt.style.color = 'black';
                catSelect.appendChild(opt);
            });
            catSelect.value = currentCat;
        }

        let filtered = db.products.filter(p => p.status !== 'deleted' && p.status !== 'canceled'); // just in case

        if (search) {
            filtered = filtered.filter(p =>
                (p.name && p.name.toLowerCase().includes(search)) ||
                (p.sku && p.sku.toLowerCase().includes(search))
            );
        }
        if (category) {
            filtered = filtered.filter(p => {
                const pCat = p.isRawMaterial ? 'Insumo' : p.category;
                return pCat === category;
            });
        }

        const salesCountMap = {};
        if (sort === 'best_sellers') {
            db.sales.forEach(sale => {
                if (sale.items) {
                    sale.items.forEach(item => {
                        if (!salesCountMap[item.productId]) salesCountMap[item.productId] = 0;
                        salesCountMap[item.productId] += item.qty;
                    });
                }
            });
        }

        filtered.sort((a, b) => {
            switch (sort) {
                case 'best_sellers': {
                    const salesA = salesCountMap[a.id] || 0;
                    const salesB = salesCountMap[b.id] || 0;
                    if (salesB !== salesA) return salesB - salesA;
                    return (a.name || '').localeCompare(b.name || '');
                }
                case 'name_asc': return (a.name || '').localeCompare(b.name || '');
                case 'name_desc': return (b.name || '').localeCompare(a.name || '');
                case 'price_asc': return (a.price || 0) - (b.price || 0);
                case 'price_desc': return (b.price || 0) - (a.price || 0);
                case 'stock_asc': return (a.stock || 0) - (b.stock || 0);
                case 'stock_desc': return (b.stock || 0) - (a.stock || 0);
                default: return 0;
            }
        });

        filtered.forEach(p => {
            let stockDisplay;
            if (p.isRawMaterial) {
                stockDisplay = `${p.stock} <span style="font-size:0.75rem;color:var(--text-muted);">(insumo)</span>`;
            } else if (p.isComposed) {
                stockDisplay = `<span style="color:var(--primary); font-weight:bold;">Composto</span>`;
            } else {
                stockDisplay = p.stock;
            }

            let catCol = p.isRawMaterial ? '<em style="color:var(--text-muted)">Insumo</em>' : (p.category || '');
            if (!p.isRawMaterial && p.category && !isCategoryActive(p.category)) {
                catCol += ' <span class="badge" style="background: rgba(239, 68, 68, 0.2); color: var(--danger); font-size: 0.7rem; padding: 2px 6px; border-radius: 10px; margin-left: 4px;">Inativa</span>';
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${p.sku || ''}</td>
                <td>${p.name || ''}</td>
                <td>${catCol}</td>
                <td>${p.isRawMaterial ? '<em style="color:var(--text-muted)">—</em>' : formatMoney(p.price || 0)}</td>
                <td>${stockDisplay}</td>
                <td>
                    <button class="btn-icon" onclick="pdvApp.editProduct('${p.id}')"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-icon danger" onclick="pdvApp.deleteProduct('${p.id}')"><i class="fa-solid fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    function toggleRawMaterial() {
        const isRaw = document.getElementById('prod-is-raw').checked;
        const groupCat = document.getElementById('group-cat');
        const groupPreco = document.getElementById('group-preco');
        const groupSku = document.getElementById('group-sku');
        const composedCheck = document.getElementById('prod-is-composed');

        if (isRaw) {
            // Hide sell-related fields
            if (groupCat) groupCat.style.display = 'none';
            if (groupPreco) groupPreco.style.display = 'none';
            if (groupSku) groupSku.style.opacity = '0.5';
            // Can't be composed if it's a raw material
            composedCheck.checked = false;
            composedCheck.disabled = true;
            document.getElementById('composition-section').style.display = 'none';
        } else {
            if (groupCat) groupCat.style.display = '';
            if (groupPreco) groupPreco.style.display = '';
            if (groupSku) groupSku.style.opacity = '1';
            composedCheck.disabled = false;
        }
    }

    function toggleComposition() {
        const isComposed = document.getElementById('prod-is-composed').checked;
        const estoqueGroup = document.getElementById('group-estoque');
        const compSection = document.getElementById('composition-section');
        const estoqueInput = document.getElementById('prod-estoque');

        if (isComposed) {
            estoqueGroup.style.display = 'none';
            estoqueInput.removeAttribute('required');
            compSection.style.display = 'block';
            populateCompositionSelect();
            renderCompositionList();
        } else {
            estoqueGroup.style.display = 'block';
            estoqueInput.setAttribute('required', 'true');
            compSection.style.display = 'none';
        }
    }

    function populateCompositionSelect() {
        const select = document.getElementById('comp-product-select');
        select.innerHTML = '<option value="">Selecione um insumo...</option>';
        const currentId = document.getElementById('prod-id').value;
        // Include raw materials AND non-composed sellable products as ingredients
        db.products.filter(p => !p.isComposed && p.id !== currentId).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.isRawMaterial ? `${p.name} (insumo)` : p.name;
            select.appendChild(opt);
        });
    }

    function addCompositionItem() {
        const select = document.getElementById('comp-product-select');
        const qtyInput = document.getElementById('comp-qty');
        const productId = select.value;
        const qty = parseInt(qtyInput.value);

        if (!productId || isNaN(qty) || qty <= 0) return;

        const existing = currentComposition.find(c => c.productId === productId);
        if (existing) {
            existing.qty += qty;
        } else {
            currentComposition.push({ productId, qty });
        }

        select.value = '';
        qtyInput.value = '1';
        renderCompositionList();
    }

    function removeCompositionItem(productId) {
        currentComposition = currentComposition.filter(c => c.productId !== productId);
        renderCompositionList();
    }

    function renderCompositionList() {
        const list = document.getElementById('composition-list');
        list.innerHTML = '';
        currentComposition.forEach(c => {
            const prod = db.products.find(p => p.id === c.productId);
            if (!prod) return;
            const li = document.createElement('li');
            li.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 5px 10px; border-radius: 5px; font-size: 0.9rem;";
            li.innerHTML = `
                <span>${c.qty}x ${prod.name}</span>
                <button type="button" class="btn-icon danger" style="width:24px;height:24px;font-size:0.8rem;" onclick="pdvApp.removeCompositionItem('${c.productId}')"><i class="fa-solid fa-xmark"></i></button>
            `;
            list.appendChild(li);
        });
    }

    function openProductModal() {
        document.getElementById('form-produto').reset();
        document.getElementById('prod-id').value = '';
        document.getElementById('modal-produto-title').textContent = 'Novo Produto';
        document.getElementById('prod-codigo').value = generateSKU();
        currentComposition = [];
        document.getElementById('prod-is-composed').disabled = false;
        toggleComposition();
        toggleRawMaterial();
        openModal('modal-produto');
    }

    async function saveProduct() {
        const id = document.getElementById('prod-id').value;
        const sku = document.getElementById('prod-codigo').value;
        const name = document.getElementById('prod-nome').value;
        const isRawMaterial = document.getElementById('prod-is-raw').checked;
        const isComposed = document.getElementById('prod-is-composed').checked;
        const isCustomizable = document.getElementById('prod-is-customizable').checked;

        // For raw materials, category and price are optional
        const category = isRawMaterial ? 'Insumo' : document.getElementById('prod-cat').value;
        const price = isRawMaterial ? 0 : parseFloat(document.getElementById('prod-preco').value);
        const stock = isComposed ? 0 : parseInt(document.getElementById('prod-estoque').value);

        if (!sku || !name) {
            showCustomAlert('Preencha pelo menos o Código e o Nome.');
            return;
        }
        if (!isRawMaterial && (isNaN(price) || !category)) {
            showCustomAlert('Preencha o Preço e a Categoria.');
            return;
        }
        if (!isComposed && isNaN(stock)) {
            showCustomAlert('Preencha o Estoque.');
            return;
        }
        if (isComposed && currentComposition.length === 0) {
            showCustomAlert('Produtos compostos devem ter pelo menos um insumo na ficha técnica.');
            return;
        }

        const productData = { id: id || generateId(), sku, name, category, price, stock, isRawMaterial, isComposed, isCustomizable, composition: [...currentComposition], updatedAt: new Date().getTime() };

        if (id) {
            const index = db.products.findIndex(p => p.id === id);
            if (index > -1) db.products[index] = productData;
        } else {
            db.products.push(productData);
        }

        saveDataLocal();
        saveProductToCloud(productData);
        closeModal('modal-produto');
        renderProductsTable();
        renderPDVProducts();
        renderCategories();
    }

    function editProduct(id) {
        const p = db.products.find(prod => prod.id === id);
        if (!p) return;
        document.getElementById('prod-id').value = p.id;
        document.getElementById('prod-codigo').value = p.sku;
        document.getElementById('prod-cat').value = p.isRawMaterial ? '' : p.category;
        document.getElementById('prod-nome').value = p.name;
        document.getElementById('prod-preco').value = p.isRawMaterial ? '' : p.price;

        document.getElementById('prod-is-raw').checked = !!p.isRawMaterial;
        document.getElementById('prod-is-composed').checked = !!p.isComposed;
        document.getElementById('prod-is-composed').disabled = !!p.isRawMaterial;
        document.getElementById('prod-is-customizable').checked = !!p.isCustomizable;
        currentComposition = p.composition ? [...p.composition] : [];
        toggleRawMaterial();
        toggleComposition();

        if (!p.isComposed) {
            document.getElementById('prod-estoque').value = p.stock;
        }

        document.getElementById('modal-produto-title').textContent = 'Editar Produto';
        openModal('modal-produto');
    }

    async function deleteProduct(id) {
        if (await showCustomConfirm('Deseja realmente excluir este produto?')) {
            const idx = db.products.findIndex(p => p.id === id);
            if (idx !== -1) {
                db.products.splice(idx, 1);
                saveDataLocal();
                renderProductsTable();
                renderPDVProducts();

                deleteProductFromCloud(id); // Envia silenciosamente
            }
        }
    }


    function renderComandas() {
        const container = document.getElementById('comandas-container');
        container.innerHTML = '';

        for (let i = 1; i <= 16; i++) {
            const pagerStr = i.toString();
            const c = db.comandas.find(com => String(com.number) === pagerStr && com.status === 'open');

            const card = document.createElement('div');
            card.className = 'comanda-card';

            if (c) {
                let itemsHtml = '<ul style="margin: 10px 0; padding-left: 20px; font-size: 0.95rem;">';
                c.items.forEach(item => {
                    itemsHtml += `<li style="margin-bottom: 5px;"><strong>${item.qty}x</strong> ${item.name}`;
                    if (item.addons && item.addons.length > 0) {
                        itemsHtml += `<ul style="margin: 2px 0 2px 10px; padding-left: 15px; color: var(--text-muted); font-size: 0.85rem; list-style-type: square;">`;
                        item.addons.forEach(addon => {
                            itemsHtml += `<li>+ ${addon.qty}x ${addon.name}</li>`;
                        });
                        itemsHtml += `</ul>`;
                    }
                    if (item.observation) {
                        itemsHtml += `<div style="margin-left: 10px; margin-top: 2px; font-size: 0.85rem; color: var(--danger); font-style: italic;">Obs: ${item.observation}</div>`;
                    }
                    itemsHtml += `</li>`;
                });
                itemsHtml += '</ul>';

                card.innerHTML = `
                    <div class="comanda-header" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                        <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                            <span class="comanda-number" style="font-size: 2.2rem; color: var(--primary);">PAGER ${i}</span>
                            <span class="comanda-status" style="background: rgba(239, 68, 68, 0.2); color: var(--danger); font-size: 1rem;">Ocupado</span>
                        </div>
                        ${c.isViagem ? `<div style="background: var(--primary); color: white; padding: 6px 10px; border-radius: var(--radius-md); font-weight: 800; width: 100%; text-align: center; text-transform: uppercase; font-size: 1.2rem; letter-spacing: 1px;">🚗 PARA VIAGEM</div>` : ''}
                    </div>
                    <div class="comanda-body" style="margin-top: 10px;">
                        ${itemsHtml}
                        <p style="font-weight: bold; font-size: 1.2rem; margin-top: 5px; color: var(--success)">Total: ${formatMoney(c.total)}</p>
                        ${c.client ? `<p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 5px;"><i class="fa-solid fa-user"></i> ${c.client}</p>` : ''}
                        <p style="font-size: 0.85rem; margin-top: 5px; color: ${c.paid ? 'var(--success)' : 'var(--danger)'}"><strong>${c.paid ? 'PAGO' : 'NÃO PAGO'}</strong></p>
                    </div>
                    <div class="comanda-actions" style="margin-top: 15px; display: flex; flex-wrap: wrap; gap: 10px;">
                        ${!c.paid ? `<button class="btn secondary" style="flex: 1;" onclick="pdvApp.payComanda('${c.id}')">Pagar</button>` : ''}
                        <button class="btn primary" style="flex: 1;" onclick="pdvApp.darBaixa('${c.id}')">Dar Baixa</button>
                        <button class="btn" style="flex: 1; background: var(--warning); color: #000;" onclick="pdvApp.reprintComanda('${c.id}')"><i class="fa-solid fa-print"></i></button>
                        <button class="btn" style="flex: 1; background: var(--danger); color: white;" onclick="pdvApp.cancelComandaSale('${c.id}')">Cancelar</button>
                    </div>
                `;
                card.style.borderColor = c.isViagem ? 'var(--primary)' : 'var(--danger)';
                if (c.isViagem) card.style.boxShadow = '0 0 15px rgba(59, 130, 246, 0.2)';
            } else {
                card.innerHTML = `
                    <div class="comanda-header">
                        <span class="comanda-number" style="color: var(--text-muted)">Pager #${i}</span>
                        <span class="comanda-status status-open">Livre</span>
                    </div>
                    <div class="comanda-body" style="display: flex; align-items: center; justify-content: center; height: 100px;">
                        <span style="color: var(--text-muted);"><i class="fa-solid fa-pager" style="font-size: 3rem; opacity: 0.2;"></i></span>
                    </div>
                `;
            }
            container.appendChild(card);
        }
    }

    async function darBaixa(id) {
        const idx = db.comandas.findIndex(c => c.id === id);
        if (idx > -1) {
            const c = db.comandas[idx];
            // FIX: prevent giving baixa to an already-canceled comanda
            if (c.status === 'canceled') {
                showCustomAlert('Esta comanda já foi cancelada e não pode ser baixada.');
                return false;
            }
            if (!c.paid && !isComandaFiado(c)) {
                showCustomAlert('Atenção: Este pedido ainda não foi pago! Pague antes de dar baixa.');
                return false;
            }
            if (await showCustomConfirm('Confirmar entrega do pedido e liberar o pager?')) {
                c.status = 'closed';
                c.updatedAt = new Date().getTime();
                saveDataLocal();
                saveComandaToCloud(c);
                renderComandas();

                if (typeof renderSideComandasList === 'function') renderSideComandasList();
                if (typeof updateRealtimeIndicators === 'function') updateRealtimeIndicators();

                if (typeof currentSelectedComandaId !== 'undefined' && currentSelectedComandaId === id) {
                    if (typeof backToComandasList === 'function') backToComandasList();
                }
                return true;
            }
        }
        return false;
    }

    function restoreStockForItem(cartItem) {
        restore(cartItem.productId, cartItem.qty);
        if (cartItem.addons && cartItem.addons.length > 0) {
            cartItem.addons.forEach(addon => {
                restore(addon.productId, addon.qty * cartItem.qty);
            });
        }
    }

    function restore(productId, qtyToRestore) {
        const prod = db.products.find(p => p.id === productId);
        if (!prod) return;
        if (prod.isComposed && prod.composition) {
            prod.composition.forEach(comp => {
                const ing = db.products.find(p => p.id === comp.productId);
                if (ing && !ing.isComposed) {
                    ing.stock += (comp.qty * qtyToRestore);
                    saveProductToCloud(ing);
                }
            });
        } else if (!prod.isComposed) {
            prod.stock += qtyToRestore;
            saveProductToCloud(prod);
        }
    }

    async function cancelComandaSale(id) {
        const idx = db.comandas.findIndex(c => c.id === id);
        if (idx === -1) return;
        const c = db.comandas[idx];

        if (await showCustomConfirm(`Tem certeza que deseja CANCELAR a Comanda #${c.number || 'SP'}? Todo o estoque será estornado e a venda será apagada.`)) {
            // Estorno OBRIGATÓRIO de estoque
            c.items.forEach(cartItem => restoreStockForItem(cartItem));

            // FIX: find linked sale by saleId (reliable) or fall back to comanda+total match
            // for older records that were created before the saleId link was introduced.
            let saleIdx = -1;
            if (c.saleId) {
                saleIdx = db.sales.findIndex(s => s.id === c.saleId && s.type === 'venda' && !s.isCanceled);
            }
            if (saleIdx === -1) {
                // Backward-compatible fallback
                for (let i = db.sales.length - 1; i >= 0; i--) {
                    if (db.sales[i].type === 'venda' && !db.sales[i].isCanceled && isMatchingSaleForComanda(db.sales[i], c)) {
                        saleIdx = i;
                        break;
                    }
                }
            }

            if (saleIdx > -1) {
                const originalSale = db.sales[saleIdx];
                // Marca a venda original para evitar cancelamentos duplicados, mas mantém como "venda"
                originalSale.isCanceled = true;
                saveSaleToCloud(originalSale);

                // Cria uma contra-partida de cancelamento com a data atual
                const cancelSale = {
                    id: generateId(),
                    seq: db.sales.length + 1,
                    date: new Date().toISOString(),
                    items: originalSale.items,
                    subtotal: originalSale.subtotal,
                    discount: originalSale.discount,
                    total: originalSale.total,
                    paymentMethod: originalSale.paymentMethod,
                    comanda: originalSale.comanda,
                    client: originalSale.client,
                    type: 'cancelamento',
                    isFeirante: originalSale.isFeirante,
                    isViagem: originalSale.isViagem,
                    feiraLocation: currentFeira ? currentFeira.location : originalSale.feiraLocation,
                    updatedAt: new Date().getTime()
                };
                db.sales.push(cancelSale);
                saveSaleToCloud(cancelSale);
            }

            c.status = 'canceled';
            c.updatedAt = new Date().getTime();
            saveDataLocal();
            saveComandaToCloud(c);
            renderComandas();
            renderAll();
            showCustomAlert('Cancelamento realizado com sucesso!');
        }
    }

    async function payComanda(id, paymentData) {
        const idx = db.comandas.findIndex(c => c.id === id);
        if (idx === -1) return;
        const c = db.comandas[idx];
        const shouldAutoCloseAfterCharge = c.paymentMethod === 'Fiado' || c.isFeirante === true;
        if (c.paid) {
            showCustomAlert('Atenção: Esta comanda já está paga!');
            return;
        }
        if ((c.isFeirante || isComandaFiado(c)) && !paymentData) {
            openFeiranteChargeModal(id);
            return;
        }

        if (paymentData) {
            const validationError = validateFeiranteChargeData(paymentData);
            if (validationError) {
                showCustomAlert(validationError);
                return;
            }
        }

        const shouldProceed = paymentData ? true : await showCustomConfirm('Confirmar o recebimento total deste pedido?');
        if (shouldProceed) {
            // Procurar a venda Fiado associada e atualizar
            let saleIdx = -1;
            if (c.saleId) {
                saleIdx = db.sales.findIndex(s => s.id === c.saleId && s.type !== 'canceled' && !s.isCanceled);
            }
            
            if (saleIdx === -1) {
                for (let i = db.sales.length - 1; i >= 0; i--) {
                    if (db.sales[i].type !== 'canceled' && !db.sales[i].isCanceled && isMatchingSaleForComanda(db.sales[i], c)) {
                        saleIdx = i;
                        break;
                    }
                }
            }

            let targetSale = null;
            if (saleIdx > -1) {
                if (!db.sales[saleIdx].comanda && c.number) {
                    db.sales[saleIdx].comanda = String(c.number);
                }
                if (!db.sales[saleIdx].client && c.client) {
                    db.sales[saleIdx].client = c.client;
                }
                if (paymentData) {
                    db.sales[saleIdx].paymentMethod = paymentData.paymentMethod;
                    db.sales[saleIdx].received = paymentData.received;
                    db.sales[saleIdx].change = 0;
                } else if (db.sales[saleIdx].paymentMethod === 'Fiado') {
                    // Transforma o Fiado em venda paga para constar no relatório do dia
                    db.sales[saleIdx].paymentMethod = 'Fiado Pago';
                }
                db.sales[saleIdx].updatedAt = new Date().getTime();
                saveSaleToCloud(db.sales[saleIdx]);
                targetSale = db.sales[saleIdx];
            }

            c.paid = true;
            if (paymentData) {
                c.paymentMethod = paymentData.paymentMethod;
                c.received = paymentData.received;
            } else if (c.paymentMethod === 'Fiado') {
                c.paymentMethod = 'Fiado Pago';
            }
            if (shouldAutoCloseAfterCharge) {
                c.status = 'closed';
            }
            c.updatedAt = new Date().getTime();

            saveDataLocal();
            saveComandaToCloud(c);
            renderComandas();

            if (paymentData) {
                closeFeiranteChargeModal();
            }

            if (typeof renderSideComandasList === 'function') renderSideComandasList();
            if (typeof updateRealtimeIndicators === 'function') updateRealtimeIndicators();
            
            // Atualiza os totais do dashboard para remover a pendência instantaneamente
            if (typeof renderDashboard === 'function') renderDashboard();

            if (typeof currentSelectedComandaId !== 'undefined' && currentSelectedComandaId === id) {
                if (shouldAutoCloseAfterCharge && typeof backToComandasList === 'function') {
                    backToComandasList();
                } else {
                    showComandaDetail(id);
                }
            }

            if (targetSale) printReceipt(targetSale);
        }
    }

    function reprintComanda(id) {
        const c = db.comandas.find(com => com.id === id);
        if (c) {
            const pseudoSale = {
                id: c.id,
                seq: '---',
                date: new Date().toISOString(),
                items: c.items,
                total: c.total,
                paymentMethod: c.paid ? 'Pago (Comanda)' : 'Aberto (Comanda)',
                comanda: c.number,
                client: c.client,
                isViagem: c.isViagem
            };
            printReceipt(pseudoSale);
        }
    }

    function renderClientsTable() {
        const tbody = document.getElementById('clients-table-body');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--text-muted)">Nenhum cliente cadastrado. Clique em Novo Cliente.</td></tr>';
    }

    function renderSettings() {
        const dEl = document.getElementById('config-doneness');
        const iEl = document.getElementById('config-ingredients');
        const configExtras = document.getElementById('config-extras');
        const configLoc = document.getElementById('config-feira-location');
        const configDate = document.getElementById('config-feira-date');
        const configCaixa = document.getElementById('config-feira-caixa');
        const configObs = document.getElementById('config-feira-obs');
        const badge = document.getElementById('feira-status-badge');
        const btnAbrir = document.getElementById('btn-abrir-feira');
        const btnEncerrar = document.getElementById('btn-encerrar-feira');

        if (dEl) dEl.value = VARIATIONS_DONENESS.join(', ');
        if (iEl) iEl.value = VARIATIONS_INGREDIENTS.join(', ');
        if (configExtras) configExtras.value = (VARIATIONS_EXTRAS || []).join(', ');

        const btnRelatorio = document.getElementById('btn-relatorio-parcial');

        if (configLoc) {
            if (currentFeira) {
                configLoc.value = currentFeira.location;
                configLoc.disabled = true;
                if (configDate) configDate.value = currentFeira.date;
                if (configCaixa) { configCaixa.value = currentFeira.caixaInicial; configCaixa.disabled = true; }
                if (configObs) { configObs.value = currentFeira.obs || ''; configObs.disabled = true; }
                if (badge) { badge.textContent = 'Aberta'; badge.style.background = 'var(--success)'; }
                if (btnAbrir) btnAbrir.style.display = 'none';
                if (btnEncerrar) btnEncerrar.style.display = '';
                if (btnRelatorio) btnRelatorio.style.display = '';
            } else {
                configLoc.value = '';
                configLoc.disabled = false;
                if (configDate) configDate.value = new Date().toISOString().split('T')[0];
                if (configCaixa) { configCaixa.value = ''; configCaixa.disabled = false; }
                if (configObs) { configObs.value = ''; configObs.disabled = false; }
                if (badge) { badge.textContent = 'Fechada'; badge.style.background = 'var(--danger)'; }
                if (btnAbrir) btnAbrir.style.display = '';
                if (btnEncerrar) btnEncerrar.style.display = 'none';
                if (btnRelatorio) btnRelatorio.style.display = 'none';
            }
        }
    }

    function exportData() {
        const dataStr = localStorage.getItem('nexus_pdv_db');
        if (!dataStr) {
            showCustomAlert('Não há dados para exportar.');
            return;
        }
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        const exportFileDefaultName = 'pdv_backup_' + new Date().toISOString().slice(0, 10) + '.json';

        let linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
    }

    function importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const contents = e.target.result;
                JSON.parse(contents); // Verifica se é um JSON válido
                localStorage.setItem('nexus_pdv_db', contents);
                showCustomAlert('Dados importados com sucesso! A página será recarregada para aplicar os dados.');
                window.location.reload();
            } catch (err) {
                showCustomAlert('Erro ao importar arquivo. Certifique-se de que é o arquivo correto (.json).');
            }
        };
        reader.readAsText(file);
        event.target.value = ''; // Reset do input
    }

    async function saveSettings() {
        const dEl = document.getElementById('config-doneness');
        const iEl = document.getElementById('config-ingredients');
        const eEl = document.getElementById('config-extras');
        if (dEl && iEl) {
            const doneness = dEl.value.split(',').map(s => s.trim()).filter(s => s);
            const ingredients = iEl.value.split(',').map(s => s.trim()).filter(s => s);
            const extras = eEl ? eEl.value.split(',').map(s => s.trim()).filter(s => s) : ['Fatiado', 'Com Farofa'];

            VARIATIONS_DONENESS = doneness.length > 0 ? doneness : ['Bem Passado'];
            VARIATIONS_INGREDIENTS = ingredients.length > 0 ? ingredients : ['Completo'];
            VARIATIONS_EXTRAS = extras.length > 0 ? extras : ['Fatiado', 'Com Farofa'];

            const settingsObj = {
                VARIATIONS_DONENESS: VARIATIONS_DONENESS,
                VARIATIONS_INGREDIENTS: VARIATIONS_INGREDIENTS,
                VARIATIONS_EXTRAS: VARIATIONS_EXTRAS
            };

            saveDataLocal();

            saveSettingsToCloud(settingsObj); // Envia silenciosamente
            showCustomAlert('Configurações salvas localmente e estão sendo enviadas para a nuvem!');
        }
    }

    // --- Histórico de Vendas ---
    function renderSalesHistory() {
        const tbody = document.getElementById('hist-table-body');
        if (!tbody) return;

        const startInput = document.getElementById('hist-date-start');
        const endInput = document.getElementById('hist-date-end');

        const getLocalYYYYMMDD = () => {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };

        if (startInput && !startInput.value) startInput.value = getLocalYYYYMMDD();
        if (endInput && !endInput.value) endInput.value = getLocalYYYYMMDD();

        const dateStartStr = startInput ? startInput.value : '';
        const dateEndStr = endInput ? endInput.value : '';
        const paymentMethod = document.getElementById('hist-payment-method').value;
        const saleType = document.getElementById('hist-sale-type').value;

        let filtered = db.sales.slice();

        // Sort descending by date
        filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        // Apply filters
        if (dateStartStr) {
            const start = new Date(dateStartStr + 'T00:00:00').getTime();
            filtered = filtered.filter(s => new Date(s.date).getTime() >= start);
        }
        if (dateEndStr) {
            const end = new Date(dateEndStr + 'T23:59:59').getTime();
            filtered = filtered.filter(s => new Date(s.date).getTime() <= end);
        }
        if (paymentMethod) {
            const targetMethod = normalizePaymentMethod(paymentMethod);
            filtered = filtered.filter(s => normalizePaymentMethod(resolveSalePaymentMethod(s)) === targetMethod);
        }
        if (saleType) {
            filtered = filtered.filter(s => s.type === saleType);
        }

        tbody.innerHTML = '';

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--text-muted);">Nenhum registro encontrado com estes filtros.</td></tr>';
            return;
        }

        filtered.forEach(sale => {
            const isCanceled = sale.isCanceled || sale.type === 'cancelamento';
            const tr = document.createElement('tr');
            if (isCanceled) tr.style.opacity = '0.7';

            const dObj = new Date(sale.date);
            const dateStr = dObj.toLocaleDateString('pt-BR') + ' ' + dObj.toLocaleTimeString('pt-BR');

            let clientStr = sale.comanda ? `Pager ${sale.comanda}` : 'Venda Direta';
            if (sale.client) clientStr += ` - ${sale.client}`;

            let statusBadge = '';
            if (sale.type === 'cancelamento') {
                statusBadge = '<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: var(--danger);">Estorno</span>';
            } else if (sale.isCanceled) {
                statusBadge = '<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: var(--danger);">Cancelada</span>';
            } else {
                statusBadge = '<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: var(--success);">Válida</span>';
            }

            const pMethod = resolveSalePaymentMethod(sale);

            tr.innerHTML = `
                <td>${dateStr}</td>
                <td>${clientStr}</td>
                <td>${sale.feiraLocation || '-'}</td>
                <td>${pMethod || '-'}</td>
                <td style="font-weight: bold; ${isCanceled ? 'text-decoration: line-through;' : ''}">${formatMoney(sale.total)}</td>
                <td>${statusBadge}</td>
                <td style="text-align: right;">
                    <button class="btn secondary" onclick="pdvApp.showSaleDetailsModal('${sale.id}')" style="padding: 4px 10px; font-size: 0.85rem;">Detalhes</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    function showSaleDetailsModal(saleId) {
        const sale = db.sales.find(s => s.id === saleId);
        if (!sale) return;

        document.getElementById('hist-detail-id').value = sale.id;

        let clientStr = sale.comanda ? `Pager ${sale.comanda}` : 'Venda Direta';
        if (sale.client) clientStr += `<br><span style="font-size: 0.85rem; color: var(--text-muted);">${sale.client}</span>`;
        document.getElementById('hist-detail-client').innerHTML = clientStr;

        const dObj = new Date(sale.date);
        document.getElementById('hist-detail-date').textContent = dObj.toLocaleDateString('pt-BR') + ' ' + dObj.toLocaleTimeString('pt-BR');

        document.getElementById('hist-detail-payment').textContent = resolveSalePaymentMethod(sale) || '-';
        document.getElementById('hist-detail-discount').textContent = sale.discount ? formatMoney(sale.discount) : 'R$ 0,00';
        document.getElementById('hist-detail-total').textContent = formatMoney(sale.total);

        const itemsContainer = document.getElementById('hist-detail-items');
        itemsContainer.innerHTML = '';
        if (sale.items && sale.items.length > 0) {
            sale.items.forEach(item => {
                let addonsHtml = '';
                if (item.addons && item.addons.length > 0) {
                    item.addons.forEach(a => {
                        addonsHtml += `<div style="font-size: 0.8rem; color: var(--text-muted); margin-left: 10px;">+ ${a.qty}x ${a.name}</div>`;
                    });
                }
                let obsHtml = item.observation ? `<div style="font-size: 0.8rem; color: var(--warning); margin-left: 10px; font-style: italic;">Obs: ${item.observation}</div>` : '';

                itemsContainer.innerHTML += `
                    <div style="padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${item.qty}x ${item.name}</span>
                            <span style="color: var(--success);">${formatMoney(item.price * item.qty)}</span>
                        </div>
                        ${addonsHtml}
                        ${obsHtml}
                    </div>
                `;
            });
        } else {
            itemsContainer.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 10px;">Sem itens detalhados</div>';
        }

        // Configure buttons
        const btnCancel = document.getElementById('btn-cancel-direct-sale');
        if (sale.type === 'cancelamento' || sale.isCanceled || sale.comanda) {
            // Cannot cancel already canceled/counter-entry sales, or sales that belong to a comanda (must cancel the comanda instead)
            btnCancel.style.display = 'none';
        } else {
            btnCancel.style.display = 'block';
        }

        document.getElementById('modal-historico-detalhes').classList.add('active');
    }

    function reprintSaleFromHistory() {
        const id = document.getElementById('hist-detail-id').value;
        const sale = db.sales.find(s => s.id === id);
        if (sale) {
            printReceipt(sale);
        }
    }

    async function cancelDirectSaleFromHistory() {
        const id = document.getElementById('hist-detail-id').value;
        const originalSale = db.sales.find(s => s.id === id);

        if (!originalSale) return;
        if (originalSale.comanda) {
            showCustomAlert('Esta venda está associada a uma comanda. Por favor, cancele a comanda na aba Comandas.');
            return;
        }

        if (await showCustomConfirm('Tem certeza que deseja cancelar esta venda direta? O estoque será estornado e o registro contabilizado como cancelado.')) {
            // Restore stock
            if (originalSale.items && originalSale.items.length > 0) {
                originalSale.items.forEach(cartItem => restoreStockForItem(cartItem));
            }

            originalSale.isCanceled = true;
            saveSaleToCloud(originalSale);

            // Create counter-entry
            const cancelSale = {
                id: generateId(),
                seq: db.sales.length + 1,
                date: new Date().toISOString(),
                items: originalSale.items,
                subtotal: originalSale.subtotal,
                discount: originalSale.discount,
                total: originalSale.total,
                paymentMethod: originalSale.paymentMethod,
                comanda: originalSale.comanda,
                client: originalSale.client,
                type: 'cancelamento',
                isFeirante: originalSale.isFeirante,
                isViagem: originalSale.isViagem,
                feiraLocation: originalSale.feiraLocation,
                updatedAt: new Date().getTime()
            };
            db.sales.push(cancelSale);
            saveSaleToCloud(cancelSale);

            closeModal('modal-historico-detalhes');
            renderSalesHistory();
            renderDashboard(); // Update dashboard totals
            showCustomAlert('Venda cancelada com sucesso!');
        }
    }

    async function refreshData() {
        const btn = document.querySelector('.btn-refresh-data');
        const icon = document.getElementById('refresh-icon');
        if (btn) btn.disabled = true;
        if (icon) icon.classList.add('spinning');
        
        try {
            await loadData();
            renderAll();
            showToast('Dados atualizados com sucesso!', 'success');
        } catch (err) {
            console.error('Erro no refresh:', err);
            showToast('Falha ao atualizar dados: ' + err.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
            if (icon) icon.classList.remove('spinning');
        }
    }

    function imprimirRelatorioParcial() {
        if (!currentFeira) {
            showToast('Nenhuma feira aberta para gerar relatório.', 'error');
            return;
        }

        const feiraStart = new Date(currentFeira.openedAt);
        const feiraSales = db.sales.filter(s =>
            s.feiraLocation === currentFeira.location &&
            new Date(s.date) >= feiraStart
        );

        let totalVendido = 0;
        let totalRecebidoDinheiro = 0;
        let qtdePedidos = 0;
        let qtdeItens = 0;
        let viagemCount = 0;
        let consumoLocalCount = 0;
        let paymentCounts = {};
        let itemsData = {};
        let totalPendencias = 0;

        feiraSales.forEach(sale => {
            if (sale.type === 'consumo' || sale.type === 'cancelamento' || sale.isCanceled) return;

            const pMethod = resolveSalePaymentMethod(sale);
            if (pMethod === 'Cancelado' || pMethod === 'Fiado Baixado') return;

            if (pMethod === 'Fiado') {
                totalPendencias = roundMoney(totalPendencias + sale.total);
                return;
            }

            totalVendido = roundMoney(totalVendido + sale.total);
            qtdePedidos++;

            if (pMethod === 'Dinheiro') totalRecebidoDinheiro = roundMoney(totalRecebidoDinheiro + sale.total);
            paymentCounts[pMethod] = roundMoney((paymentCounts[pMethod] || 0) + sale.total);

            if (sale.isViagem) viagemCount++;
            else consumoLocalCount++;

            sale.items.forEach(item => {
                qtdeItens += item.qty;
                if (!itemsData[item.name]) itemsData[item.name] = { qty: 0, rev: 0 };
                itemsData[item.name].qty += item.qty;
                let itemTotal = item.price * item.qty;
                if (item.addons) item.addons.forEach(a => itemTotal += a.price * a.qty * item.qty);
                itemsData[item.name].rev = roundMoney(itemsData[item.name].rev + itemTotal);
            });
        });

        const sortedItems = Object.entries(itemsData).sort((a, b) => b[1].rev - a[1].rev);
        const topItem = sortedItems.length > 0 ? sortedItems[0][0] : 'Nenhum';
        const ticketMedio = qtdePedidos > 0 ? totalVendido / qtdePedidos : 0;
        const esperadoEmCaixa = currentFeira.caixaInicial + totalRecebidoDinheiro;

        const dateStr = new Date().toLocaleString('pt-BR');

        let reportHtml = `
            <div class="report-print-body">
                <div class="r-brand">
                    <h2 class="r-brand-name">RELATÓRIO PARCIAL</h2>
                </div>
                <hr class="r-sep-bold">
                
                <div class="r-section-title">Resumo Geral</div>
                <div class="r-meta"><span>Local:</span> <span>${currentFeira.location}</span></div>
                <div class="r-meta-full">Abertura: ${new Date(currentFeira.openedAt).toLocaleString('pt-BR')}</div>
                <div class="r-meta-full">Gerado em: ${dateStr}</div>
                <div class="r-meta"><span>Caixa Inicial:</span> <span>${formatMoney(currentFeira.caixaInicial)}</span></div>
                <hr class="r-sep">
                <div class="r-total-row"><span>Total Vendido:</span> <span>${formatMoney(totalVendido)}</span></div>
                <hr class="r-sep-bold">

                ${qtdePedidos === 0 ? `
                <div class="r-meta-full" style="text-align: center; font-weight: bold; padding: 8px 0;">Nenhuma movimentação encontrada até o momento.</div>
                <hr class="r-sep-bold">
                ` : ''}

                <div class="r-section-title">Indicadores</div>
                <div class="r-meta"><span>Pedidos:</span> <span>${qtdePedidos}</span></div>
                <div class="r-meta"><span>Itens Vendidos:</span> <span>${qtdeItens}</span></div>
                <div class="r-meta"><span>Ticket Médio:</span> <span>${formatMoney(ticketMedio)}</span></div>
                <div class="r-meta-full" style="font-weight: bold; margin-top: 4px;">Mais Vendido: ${topItem}</div>
                <hr class="r-sep">

                <div class="r-section-title">Tipos de Pedido</div>
                <div class="r-meta"><span>Para Viagem:</span> <span>${viagemCount} (${qtdePedidos > 0 ? Math.round((viagemCount / qtdePedidos) * 100) : 0}%)</span></div>
                <div class="r-meta"><span>No Local:</span> <span>${consumoLocalCount} (${qtdePedidos > 0 ? Math.round((consumoLocalCount / qtdePedidos) * 100) : 0}%)</span></div>
                <hr class="r-sep-bold">

                <div class="r-section-title">Pagamentos</div>
                ${Object.keys(paymentCounts).length === 0 ? `
                    <div class="r-meta-full" style="text-align: center;">Nenhum pagamento registrado no período.</div>
                ` : Object.entries(paymentCounts).map(([method, val]) => `
                    <div class="r-item-header" style="font-size: 12px;">
                        <span class="r-item-name">${method}</span>
                        <span class="r-item-dots"></span>
                        <span class="r-item-price">${formatMoney(val)}</span>
                    </div>
                `).join('')}
                <hr class="r-sep-bold">

                <div class="r-section-title">Controle de Caixa (Físico)</div>
                <div class="r-meta"><span>Caixa Inicial:</span> <span>${formatMoney(currentFeira.caixaInicial)}</span></div>
                <div class="r-meta"><span>Em Dinheiro:</span> <span>${formatMoney(totalRecebidoDinheiro)}</span></div>
                <div class="r-total-row"><span>Esperado no Caixa:</span> <span>${formatMoney(esperadoEmCaixa)}</span></div>
                <hr class="r-sep-bold">

                ${totalPendencias > 0 ? `
                <div class="r-section-title">Valores Pendentes a Receber</div>
                <div class="r-meta"><span>Fiado (Aberto):</span> <span style="font-weight: bold;">${formatMoney(totalPendencias)}</span></div>
                <hr class="r-sep-bold">
                ` : ''}

                <div class="r-section-title">Cancelamentos no Período</div>
                <div class="r-meta"><span>Vendas Canceladas:</span> <span>${feiraSales.filter(s => s.type === 'cancelamento' || s.type === 'canceled').length}</span></div>
                <div class="r-meta"><span>Valor Cancelado:</span> <span>${formatMoney(feiraSales.reduce((sum, s) => sum + (s.type === 'cancelamento' || s.type === 'canceled' ? s.total : 0), 0))}</span></div>
                <hr class="r-sep-bold">

                <div class="r-section-title">Vendas por Produto</div>
                ${sortedItems.length === 0 ? `
                    <div class="r-meta-full" style="text-align: center;">Nenhum item vendido no período.</div>
                ` : sortedItems.map(([name, data]) => `
                    <div class="r-item-header" style="font-size: 12px;">
                        <span class="r-item-name">${data.qty}x ${name}</span>
                        <span class="r-item-dots"></span>
                        <span class="r-item-price">${formatMoney(data.rev)}</span>
                    </div>
                `).join('')}

                ${currentFeira.obs ? `
                    <hr class="r-sep-bold">
                    <div class="r-section-title">Observações</div>
                    <div class="r-meta-full" style="text-align: left; font-style: italic;">${currentFeira.obs}</div>
                ` : ''}

                <hr class="r-sep" style="margin-top: 40px;">
                <div class="r-footer">Assinatura do Responsável</div>
                <div class="r-footer" style="margin-top: 10px;">PDV Offline • Parcial</div>
            </div>
        `;

        const receiptContainer = document.getElementById('receipt-container');
        const reportContainer = document.getElementById('report-container');
        if (receiptContainer) receiptContainer.innerHTML = '';
        if (reportContainer) reportContainer.innerHTML = reportHtml;
        triggerMainDocumentPrint('report');
    }

    // Public API
    return {
        init,
        addToCart,
        updateCartQty,
        updateCartItemAddonQty,
        clearCart,
        openCheckoutModal,
        finishSale,
        finishConsumo,
        renderComandas,
        darBaixa,
        payComanda,
        reprintComanda,
        cancelComandaSale,
        openProductModal,
        closeProductModal: () => closeModal('modal-produto'),
        saveProduct,
        editProduct,
        deleteProduct,
        toggleComposition,
        toggleRawMaterial,
        addCompositionItem,
        removeCompositionItem,
        openCustomizeModal,
        updateCustomizeQty,
        updateCustomizeAddonQty,
        addSelectedAddon,
        toggleVariation,
        confirmCustomization,
        closeModal,
        saveSettings,
        openPagersPanel,
        closePagersPanel,
        backToComandasList,
        chargeSelectedComanda,
        confirmFeiranteCharge,
        closeSelectedComanda,
        closeFeiranteChargeModal,
        printSelectedComanda,
        cancelSelectedComanda,
        exportData,
        importData,
        syncFullDatabase,
        renderProductsTable,
        renderDashboard,
        toggleValuesVisibility,
        applyDatePreset,
        abrirFeira,
        encerrarFeira,
        renderSalesHistory,
        showSaleDetailsModal,
        reprintSaleFromHistory,
        refreshData,
        imprimirRelatorioParcial,
        openCategoryManagementModal,
        toggleCategoryStatus,
        openPDVInsumosModal,
        updatePDVInsumosAlerts,
        loadWebOrders,
        renderWebOrders,
        updateWebOrderStatus,
        filterWebOrders
    };
})();

// Bootstrap
document.addEventListener('DOMContentLoaded', pdvApp.init);

