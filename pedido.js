const pedidoApp = (function () {
    // Supabase Initialization
    const supabaseUrl = 'https://esszyrczuipzmsvkxnwn.supabase.co';
    const supabaseKey = 'sb_publishable_0H-TgPw4csT53m6_QEQuqQ_0Ib51bs-';
    let supabase = null;

    function getSupabaseClient() {
        if (!supabase) {
            if (!window.supabase || !window.supabase.createClient) {
                console.error('Supabase SDK CDN ainda não carregou.');
                return null;
            }
            supabase = window.supabase.createClient(supabaseUrl, supabaseKey);
        }
        return supabase;
    }

    // Mercado Pago Public Key
    const mpPublicKey = 'APP_USR-aa2bf58d-77d1-440c-b95e-9a6479442e57';
    let mp;
    try {
        if (typeof MercadoPago !== 'undefined') {
            mp = new MercadoPago(mpPublicKey, { locale: 'pt-BR' });
        }
    } catch(e) {
        console.warn('Mercado Pago não pôde ser inicializado:', e.message);
    }

    let products = [];
    let cart = []; // Array of { product, quantity, variations, addons }
    let categories = new Set();
    let currentCategory = 'Todos';
    let searchQuery = '';
    let lastPlacedOrderId = null;
    let trackerRealtimeChannel = null;

    // Customization variables
    let currentCustomizeProduct = null;
    let currentCustomizeVariations = [];
    let currentCustomizeQty = 1;
    let currentCustomizeAddons = []; // [{ product, qty }]

    const VARIATIONS_DONENESS = ['Mal Passado', 'Ao Ponto para Mal', 'Ao Ponto', 'Ao Ponto para Bem', 'Bem Passado'];
    const VARIATIONS_INGREDIENTS = ['Sem Cebola', 'Sem Pimentão', 'Sem Tomate', 'Sem Alface', 'Sem Maionese'];
    const VARIATIONS_EXTRAS = ['Embalar pra Viagem'];

    // --- Loading Overlay ---
    function showLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.style.display = 'flex';
    }
    function hideLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.style.display = 'none';
    }

    // --- ID Generator ---
    function generateId() {
        return `web_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // --- Storage de Pedidos Recentes & Dados do Cliente ---
    function saveRecentOrderId(orderId) {
        if (!orderId) return;
        lastPlacedOrderId = String(orderId);
        try {
            let recent = JSON.parse(localStorage.getItem('edu_recent_orders') || '[]');
            recent = recent.filter(id => id !== String(orderId));
            recent.unshift(String(orderId));
            localStorage.setItem('edu_recent_orders', JSON.stringify(recent.slice(0, 10)));
        } catch(e) {
            console.warn('Erro ao salvar pedido recente no storage:', e);
        }
    }

    function getRecentOrders() {
        try {
            return JSON.parse(localStorage.getItem('edu_recent_orders') || '[]');
        } catch(e) {
            return [];
        }
    }

    function saveCustomerInfoLocally(name, lastname, phone) {
        try {
            localStorage.setItem('edu_customer_info', JSON.stringify({ name, lastname, phone }));
        } catch(e) {}
    }

    function getSavedCustomerInfo() {
        try {
            return JSON.parse(localStorage.getItem('edu_customer_info') || '{}');
        } catch(e) {
            return {};
        }
    }

    // --- Carregamento de Produtos do Supabase ---
    async function loadProducts(retries = 2) {
        showLoading();
        try {
            const client = getSupabaseClient();
            if (!client) {
                if (retries > 0) {
                    await new Promise(r => setTimeout(r, 600));
                    return await loadProducts(retries - 1);
                }
                throw new Error('Supabase SDK não pôde ser inicializado. Verifique a conexão.');
            }

            const { data, error } = await client.from('products').select('*');
            if (error) throw error;

            // Filtra insumos (matérias-primas)
            products = (data || []).filter(p => {
                const cat = (p.category || '').toLowerCase().trim();
                return cat !== 'insumos' && !(p.israwmaterial === true || p.israwmaterial === 'true');
            });

            categories.clear();
            categories.add('Todos');
            products.forEach(p => {
                if (p.category) categories.add(p.category);
            });

            renderCategories();
            renderProducts();
            setupRealtimeProducts();
        } catch (err) {
            console.error('Erro ao carregar produtos:', err);
            if (retries > 0) {
                console.log('Tentando recarregar cardápio...');
                await new Promise(r => setTimeout(r, 800));
                return await loadProducts(retries - 1);
            }
            alert(`Erro ao carregar cardápio: ${err?.message || 'Falha de conexão com o banco de dados.'}`);
        } finally {
            hideLoading();
        }
    }

    // --- Sincronização em Tempo Real de Estoque ---
    function setupRealtimeProducts() {
        const client = getSupabaseClient();
        if (!client) return;
        client.channel('public:products')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, payload => {
                if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
                    const idx = products.findIndex(p => String(p.id) === String(payload.new.id));
                    if (idx > -1) {
                        products[idx] = payload.new;
                    } else {
                        const p = payload.new;
                        const cat = (p.category || '').toLowerCase().trim();
                        if (cat !== 'insumos' && !(p.israwmaterial === true || p.israwmaterial === 'true')) {
                            products.push(p);
                        }
                    }
                    renderProducts();
                    updateCartUI();
                }
            })
            .subscribe();
    }

    // --- Filtro de Busca ---
    function filterSearch(query) {
        searchQuery = (query || '').trim().toLowerCase();
        const clearBtn = document.getElementById('search-clear-btn');
        if (clearBtn) {
            clearBtn.style.display = searchQuery ? 'block' : 'none';
        }
        renderProducts();
    }

    function clearSearch() {
        const input = document.getElementById('search-input');
        if (input) input.value = '';
        filterSearch('');
    }

    // --- Renderização das Categorias ---
    function renderCategories() {
        const container = document.getElementById('categories-nav');
        if (!container) return;
        container.innerHTML = '';

        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = `category-chip ${currentCategory === cat ? 'active' : ''}`;
            
            let icon = 'fa-tag';
            const catLower = cat.toLowerCase();
            if (cat === 'Todos') icon = 'fa-utensils';
            else if (catLower.includes('espeto')) icon = 'fa-fire';
            else if (catLower.includes('lanche') || catLower.includes('burger')) icon = 'fa-burger';
            else if (catLower.includes('bebida') || catLower.includes('refrigerante') || catLower.includes('cerveja')) icon = 'fa-wine-bottle';
            else if (catLower.includes('porcao') || catLower.includes('porção')) icon = 'fa-bowl-food';
            else if (catLower.includes('sobremesa')) icon = 'fa-ice-cream';

            btn.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${cat}</span>`;
            btn.onclick = () => {
                currentCategory = cat;
                renderCategories();
                renderProducts();
            };
            container.appendChild(btn);
        });
    }

    // --- Renderização dos Produtos ---
    function renderProducts() {
        const container = document.getElementById('products-grid');
        const titleEl = document.getElementById('current-category-title');
        const counterEl = document.getElementById('products-counter');
        if (!container) return;
        container.innerHTML = '';

        let filtered = currentCategory === 'Todos'
            ? products
            : products.filter(p => p.category === currentCategory);

        if (searchQuery) {
            filtered = filtered.filter(p => 
                (p.name && p.name.toLowerCase().includes(searchQuery)) ||
                (p.category && p.category.toLowerCase().includes(searchQuery)) ||
                (p.description && p.description.toLowerCase().includes(searchQuery))
            );
        }

        if (titleEl) {
            titleEl.innerHTML = `<i class="fa-solid fa-utensils"></i> <span>${currentCategory}</span>`;
        }
        if (counterEl) {
            counterEl.textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'itens'}`;
        }

        if (filtered.length === 0) {
            container.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 48px 16px; color: var(--text-muted);">
                    <i class="fa-solid fa-magnifying-glass" style="font-size: 2rem; margin-bottom: 12px; opacity: 0.5;"></i>
                    <p style="font-weight: 700; font-size: 1rem; color: var(--text-secondary);">Nenhum produto encontrado</p>
                    <span style="font-size: 0.85rem;">Tente buscar por outro termo ou categoria.</span>
                </div>
            `;
            return;
        }

        filtered.forEach(p => {
            const qty = cart.filter(item => item.product.id === p.id).reduce((sum, item) => sum + item.quantity, 0);
            const card = document.createElement('div');

            const isComposed = p.iscomposed === true || p.iscomposed === 'true';
            const stock = Number(p.stock) || 0;
            const isOutOfStock = !isComposed && stock <= 0;
            const isLowStock = !isComposed && stock > 0 && stock <= 5;

            card.className = `product-card${isOutOfStock ? ' out-of-stock' : ''}`;

            let badgeHtml = '';
            if (isOutOfStock) {
                badgeHtml = `<span class="badge-stock out">Esgotado</span>`;
            } else if (isLowStock) {
                badgeHtml = `<span class="badge-stock low">Últimas ${stock}</span>`;
            }

            let actionHtml = '';
            if (isOutOfStock) {
                actionHtml = `<span class="out-of-stock-text">Indisponível</span>`;
            } else if (qty > 0) {
                actionHtml = `
                    <button class="btn-card-add has-qty" onclick="pedidoApp.openCustomizeModal('${p.id}')" title="Alterar ou adicionar mais">
                        <i class="fa-solid fa-check"></i> ${qty}
                    </button>
                `;
            } else {
                actionHtml = `
                    <button class="btn-card-add" onclick="pedidoApp.openCustomizeModal('${p.id}')" title="Adicionar">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                `;
            }

            card.innerHTML = `
                <div class="product-card-top">
                    <div class="product-meta-row">
                        <span class="product-category-tag">${p.category || 'Geral'}</span>
                        ${badgeHtml}
                    </div>
                    <div class="product-title">${p.name}</div>
                </div>
                <div class="product-card-footer">
                    <div class="product-price">R$ ${Number(p.price).toFixed(2).replace('.', ',')}</div>
                    ${actionHtml}
                </div>
            `;
            container.appendChild(card);
        });
    }

    // --- Controle de Modais ---
    function openModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.add('active');
    }

    function closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.remove('active');
        if (id === 'tracker-modal' && trackerRealtimeChannel) {
            const client = getSupabaseClient();
            if (client && trackerRealtimeChannel) {
                client.removeChannel(trackerRealtimeChannel);
                trackerRealtimeChannel = null;
            }
        }
    }

    // --- Personalização do Produto ---
    function openCustomizeModal(productId) {
        const prod = products.find(p => p.id === productId);
        if (!prod) return;

        currentCustomizeProduct = prod;
        currentCustomizeVariations = [];
        currentCustomizeAddons = [];
        
        // Padrão de Ponto da Carne para Carnes e Espetos
        const isEspeto = prod.name.toLowerCase().includes('espeto') || (prod.category && prod.category.toLowerCase().includes('espeto'));
        const isCarne = prod.name.toLowerCase().includes('carne') || prod.name.toLowerCase().includes('alcatra') || prod.name.toLowerCase().includes('picanha') || prod.name.toLowerCase().includes('contra');
        if (isEspeto || isCarne) {
            currentCustomizeVariations = ['Ao Ponto'];
        }

        currentCustomizeQty = 1;
        const qtyEl = document.getElementById('customize-qty');
        if (qtyEl) qtyEl.textContent = currentCustomizeQty;

        document.getElementById('customize-product-id').value = prod.id;
        document.getElementById('customize-product-name').textContent = prod.name;
        document.getElementById('customize-product-price').textContent = `R$ ${Number(prod.price).toFixed(2).replace('.', ',')}`;

        populateAddonSelect();
        renderCustomizeVariations();
        renderCustomizeAddons();
        openModal('modal-customize');
    }

    function populateAddonSelect() {
        const select = document.getElementById('customize-addon-select');
        if (!select) return;
        select.innerHTML = '';

        const availableAddons = products.filter(p =>
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
                opt.textContent = `${prod.name} (+R$ ${Number(finalPrice).toFixed(2).replace('.', ',')})`;
                select.appendChild(opt);
            });
        }
    }

    function addSelectedAddon() {
        const select = document.getElementById('customize-addon-select');
        if (!select || !select.value) return;
        updateCustomizeAddonQty(select.value, 1);
    }

    function renderCustomizeVariations() {
        const isLanche = currentCustomizeProduct && (
            currentCustomizeProduct.name.toLowerCase().includes('lanche') ||
            (currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('lanche'))
        );

        const isBebida = currentCustomizeProduct && (
            currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('bebida')
        );

        const donenessContainer = document.getElementById('customize-doneness-container');
        if (donenessContainer) {
            donenessContainer.style.display = isBebida ? 'none' : 'flex';
        }

        const addonsContainer = document.getElementById('customize-addons-container');
        if (addonsContainer) {
            addonsContainer.style.display = isLanche ? 'flex' : 'none';
        }

        const ingredientsContainer = document.getElementById('customize-ingredients-container');
        if (ingredientsContainer) {
            ingredientsContainer.style.display = isLanche ? 'flex' : 'none';
        }
        
        const ingredientsList = document.getElementById('customize-variations-ingredients-list');
        if (ingredientsList && isLanche) {
            ingredientsList.innerHTML = '';
            VARIATIONS_INGREDIENTS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `chip-option ${isSelected ? 'selected' : ''}`;
                btn.innerHTML = `<i class="fa-solid ${isSelected ? 'fa-xmark' : 'fa-minus'}"></i> ${vari}`;
                btn.onclick = () => toggleVariation(vari);
                ingredientsList.appendChild(btn);
            });
        }

        const donenessList = document.getElementById('customize-variations-doneness-list');
        if (donenessList && !isBebida) {
            donenessList.innerHTML = '';
            VARIATIONS_DONENESS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `chip-option ${isSelected ? 'selected' : ''}`;
                btn.textContent = vari;
                btn.onclick = () => {
                    currentCustomizeVariations = currentCustomizeVariations.filter(v => !VARIATIONS_DONENESS.includes(v));
                    currentCustomizeVariations.push(vari);
                    renderCustomizeVariations();
                };
                donenessList.appendChild(btn);
            });
        }

        const extrasContainer = document.getElementById('customize-extras-container');
        if (extrasContainer) {
            extrasContainer.style.display = 'flex';
        }
        const extrasList = document.getElementById('customize-variations-extras-list');
        if (extrasList) {
            extrasList.innerHTML = '';
            VARIATIONS_EXTRAS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `chip-option ${isSelected ? 'selected' : ''}`;
                btn.innerHTML = `<i class="fa-solid ${isSelected ? 'fa-check' : 'fa-plus'}"></i> ${vari}`;
                btn.onclick = () => toggleVariation(vari);
                extrasList.appendChild(btn);
            });
        }
        updateCustomizeTotal();
    }

    function toggleVariation(vari) {
        if (currentCustomizeVariations.includes(vari)) {
            currentCustomizeVariations = currentCustomizeVariations.filter(v => v !== vari);
        } else {
            currentCustomizeVariations.push(vari);
        }
        renderCustomizeVariations();
    }

    function updateCustomizeAddonQty(productId, delta) {
        const prod = products.find(p => p.id === productId);
        if (!prod) return;

        const isLanche = currentCustomizeProduct && (
            currentCustomizeProduct.name.toLowerCase().includes('lanche') ||
            (currentCustomizeProduct.category && currentCustomizeProduct.category.toLowerCase().includes('lanche'))
        );
        const finalPrice = isLanche ? Math.max(0, prod.price - 1) : prod.price;
        const prodCopy = { ...prod, price: finalPrice };

        const existing = currentCustomizeAddons.find(a => a.product.id === productId);
        if (existing) {
            existing.qty += delta;
            if (existing.qty <= 0) {
                currentCustomizeAddons = currentCustomizeAddons.filter(a => a.product.id !== productId);
            }
        } else if (delta > 0) {
            currentCustomizeAddons.push({ product: prodCopy, qty: delta });
        }
        renderCustomizeAddons();
    }

    function renderCustomizeAddons() {
        const list = document.getElementById('customize-addons-list');
        if (!list) return;
        list.innerHTML = '';

        currentCustomizeAddons.forEach(a => {
            const div = document.createElement('div');
            div.className = 'addon-active-item';
            div.innerHTML = `
                <div>
                    <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-main);">${a.product.name}</div>
                    <div style="color: var(--success); font-size: 0.8rem; font-weight: 700;">+ R$ ${Number(a.product.price).toFixed(2).replace('.', ',')}</div>
                </div>
                <div class="stepper-widget" style="transform: scale(0.85); transform-origin: right;">
                    <button type="button" class="stepper-btn" onclick="pedidoApp.updateCustomizeAddonQty('${a.product.id}', -1)">-</button>
                    <span class="stepper-value">${a.qty}</span>
                    <button type="button" class="stepper-btn" onclick="pedidoApp.updateCustomizeAddonQty('${a.product.id}', 1)">+</button>
                </div>
            `;
            list.appendChild(div);
        });
        updateCustomizeTotal();
    }

    function updateCustomizeQty(delta) {
        const newQty = currentCustomizeQty + delta;
        if (newQty < 1) return;
        currentCustomizeQty = newQty;
        const qtyEl = document.getElementById('customize-qty');
        if (qtyEl) qtyEl.textContent = currentCustomizeQty;
        updateCustomizeTotal();
    }

    function updateCustomizeTotal() {
        if (!currentCustomizeProduct) return;
        let total = Number(currentCustomizeProduct.price);
        currentCustomizeAddons.forEach(a => {
            total += Number(a.product.price) * a.qty;
        });
        total *= currentCustomizeQty;
        
        const totalEl = document.getElementById('customize-total');
        if (totalEl) totalEl.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
    }

    function confirmCustomization() {
        if (!currentCustomizeProduct) return;
        
        const isComposed = currentCustomizeProduct.iscomposed === true || currentCustomizeProduct.iscomposed === 'true';
        const stock = Number(currentCustomizeProduct.stock) || 0;
        
        const currentTotalQty = cart.filter(i => i.product.id === currentCustomizeProduct.id).reduce((sum, i) => sum + i.quantity, 0);
        
        if (!isComposed && (currentTotalQty + currentCustomizeQty) > stock) {
            alert(`Apenas ${stock} unidade(s) de "${currentCustomizeProduct.name}" disponível(is) em estoque.`);
            return;
        }

        const identicalIdx = cart.findIndex(item => {
            if (item.product.id !== currentCustomizeProduct.id) return false;
            
            const v1 = [...item.variations].sort();
            const v2 = [...currentCustomizeVariations].sort();
            if (v1.join(',') !== v2.join(',')) return false;
            
            if (item.addons.length !== currentCustomizeAddons.length) return false;
            const a1 = [...item.addons].sort((a,b) => String(a.product.id).localeCompare(String(b.product.id)));
            const a2 = [...currentCustomizeAddons].sort((a,b) => String(a.product.id).localeCompare(String(b.product.id)));
            for(let i=0; i<a1.length; i++) {
                if (a1[i].product.id !== a2[i].product.id || a1[i].qty !== a2[i].qty) return false;
            }
            return true;
        });

        if (identicalIdx > -1) {
            cart[identicalIdx].quantity += currentCustomizeQty;
        } else {
            cart.push({
                product: currentCustomizeProduct,
                quantity: currentCustomizeQty,
                variations: [...currentCustomizeVariations],
                addons: [...currentCustomizeAddons].map(a => ({...a, product: {...a.product}}))
            });
        }

        closeModal('modal-customize');
        renderProducts();
        updateCartUI();
    }

    // --- Gerenciamento da Sacola (Carrinho) ---
    function updateCartIndex(index, delta) {
        if (!cart[index]) return;
        const item = cart[index];
        const isComposed = item.product.iscomposed === true || item.product.iscomposed === 'true';
        const stock = Number(item.product.stock) || 0;
        
        const currentTotalQty = cart.filter(i => i.product.id === item.product.id).reduce((sum, i) => sum + i.quantity, 0);
        
        if (delta > 0 && !isComposed && currentTotalQty >= stock) {
            alert(`Apenas ${stock} unidade(s) de "${item.product.name}" disponível(is) em estoque.`);
            return;
        }

        item.quantity += delta;
        if (item.quantity <= 0) {
            cart.splice(index, 1);
        }

        renderProducts();
        updateCartUI();
    }

    function clearEntireCart() {
        if (cart.length === 0) return;
        if (confirm('Deseja realmente limpar toda a sua sacola?')) {
            cart = [];
            renderProducts();
            updateCartUI();
        }
    }

    function getCartTotal() {
        let total = 0;
        let count = 0;
        cart.forEach(item => {
            let itemPrice = Number(item.product.price);
            if (item.addons) {
                item.addons.forEach(a => itemPrice += (Number(a.product.price) * a.qty));
            }
            total += itemPrice * item.quantity;
            count += item.quantity;
        });
        return { total, count };
    }

    function validateCartAgainstStock() {
        let initialLen = cart.length;
        cart = cart.filter(item => products.some(p => p.id === item.product.id));
        if (cart.length !== initialLen) {
            renderProducts();
            renderCartModal();
        }
    }

    function updateCartUI() {
        validateCartAgainstStock();
        const { total, count } = getCartTotal();
        const cartBar = document.getElementById('cart-bar');
        const badge = document.getElementById('cart-badge');
        const totalBar = document.getElementById('cart-total-bar');

        if (count > 0) {
            cartBar.classList.remove('hidden');
            badge.textContent = count;
            totalBar.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
        } else {
            cartBar.classList.add('hidden');
        }
        renderCartModal();
    }

    function toggleCart() {
        const modal = document.getElementById('cart-modal');
        if (modal.classList.contains('active')) {
            modal.classList.remove('active');
        } else {
            renderCartModal();
            modal.classList.add('active');
        }
    }

    function renderCartModal() {
        const container = document.getElementById('cart-items');
        const totalModal = document.getElementById('cart-total-modal');
        const cartFooter = document.getElementById('cart-footer');
        const clearBtn = document.getElementById('btn-clear-cart');
        const { total, count } = getCartTotal();

        if (!container) return;
        container.innerHTML = '';

        if (count === 0) {
            container.innerHTML = `
                <div class="cart-empty-view">
                    <i class="fa-solid fa-bag-shopping cart-empty-icon"></i>
                    <p style="font-weight: 700; font-size: 1.05rem; color: var(--text-secondary);">Sua sacola está vazia</p>
                    <span style="font-size: 0.88rem; color: var(--text-muted);">Adicione itens saborosos do nosso cardápio!</span>
                </div>`;
            if (totalModal) totalModal.textContent = 'R$ 0,00';
            if (cartFooter) cartFooter.style.display = 'none';
            if (clearBtn) clearBtn.style.display = 'none';
            return;
        }

        if (clearBtn) clearBtn.style.display = 'inline-flex';
        if (cartFooter) cartFooter.style.display = 'block';
        if (totalModal) totalModal.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;

        const subtotalEl = document.getElementById('cart-subtotal');
        if (subtotalEl) subtotalEl.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;

        cart.forEach((item, index) => {
            let itemTotal = Number(item.product.price);
            let modsText = '';
            if (item.variations && item.variations.length > 0) {
                modsText += item.variations.join(', ');
            }
            if (item.addons && item.addons.length > 0) {
                item.addons.forEach(a => {
                    itemTotal += Number(a.product.price) * a.qty;
                    modsText += (modsText ? ' · ' : '') + `+${a.qty}x ${a.product.name}`;
                });
            }

            const div = document.createElement('div');
            div.className = 'cart-item-row';
            div.innerHTML = `
                <div class="cart-item-info">
                    <div class="cart-item-name">${item.product.name}</div>
                    ${modsText ? `<div class="cart-item-customizations">${modsText}</div>` : ''}
                    <div class="cart-item-price">R$ ${Number(itemTotal * item.quantity).toFixed(2).replace('.', ',')}</div>
                </div>
                <div class="stepper-widget">
                    <button class="stepper-btn" onclick="pedidoApp.updateCartIndex(${index}, -1)" aria-label="Remover">
                        <i class="fa-solid ${item.quantity === 1 ? 'fa-trash-can' : 'fa-minus'}" style="${item.quantity === 1 ? 'color:var(--danger)' : ''}"></i>
                    </button>
                    <span class="stepper-value">${item.quantity}</span>
                    <button class="stepper-btn" onclick="pedidoApp.updateCartIndex(${index}, 1)" aria-label="Adicionar">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            `;
            container.appendChild(div);
        });
    }

    // =========================================================
    // FLUXO DE CHECKOUT EM ETAPAS (IDENTIFICAÇÃO -> PAGAMENTO)
    // =========================================================
    let checkoutCurrentStep = 1;
    let selectedPaymentMethodKey = null;

    function openCheckoutForm() {
        if (getCartTotal().count === 0) {
            alert('Adicione pelo menos 1 item na sacola antes de prosseguir.');
            return;
        }

        document.getElementById('cart-modal').classList.remove('active');
        document.getElementById('checkout-modal').classList.add('active');

        // Preenche dados salvos do cliente caso existam
        const saved = getSavedCustomerInfo();
        const nameInput = document.getElementById('client-name');
        const lastnameInput = document.getElementById('client-lastname');
        const phoneInput = document.getElementById('client-phone');
        if (nameInput && !nameInput.value && saved.name) nameInput.value = saved.name;
        if (lastnameInput && !lastnameInput.value && saved.lastname) lastnameInput.value = saved.lastname;
        if (phoneInput && !phoneInput.value && saved.phone) phoneInput.value = saved.phone;

        goToCheckoutStep(1);
    }

    function goToCheckoutStep(step) {
        checkoutCurrentStep = step;
        const step1 = document.getElementById('checkout-step-1-content');
        const step2 = document.getElementById('checkout-step-2-content');
        const prog1 = document.getElementById('prog-step-1');
        const prog2 = document.getElementById('prog-step-2');
        const titleEl = document.getElementById('checkout-header-title');

        if (step === 1) {
            if (step1) step1.style.display = 'block';
            if (step2) step2.style.display = 'none';
            if (prog1) prog1.classList.add('active');
            if (prog2) prog2.classList.remove('active');
            if (titleEl) titleEl.textContent = 'Identificação';
        } else if (step === 2) {
            if (step1) step1.style.display = 'none';
            if (step2) step2.style.display = 'block';
            if (prog1) prog1.classList.add('active');
            if (prog2) prog2.classList.add('active');
            if (titleEl) titleEl.textContent = 'Resumo & Pagamento';
            renderCheckoutSummary();
        }
    }

    function proceedToPaymentStep() {
        const name = document.getElementById('client-name').value.trim();
        const lastname = document.getElementById('client-lastname').value.trim();
        const phone = document.getElementById('client-phone').value.trim();

        if (!name || !lastname) {
            alert('Por favor, informe seu Nome e Sobrenome.');
            return;
        }

        const phoneDigits = phone.replace(/\D/g, '');
        if (phoneDigits.length < 10) {
            alert('Por favor, informe um número de WhatsApp válido com DDD (Ex: 11 99999-9999).');
            return;
        }

        saveCustomerInfoLocally(name, lastname, phone);
        goToCheckoutStep(2);
    }

    function backToDetailsStep() {
        goToCheckoutStep(1);
    }

    function renderCheckoutSummary() {
        const { total } = getCartTotal();
        const list = document.getElementById('checkout-items-list');
        const totalDisplay = document.getElementById('checkout-total-display');
        if (!list) return;
        list.innerHTML = '';

        cart.forEach(item => {
            let itemTotal = Number(item.product.price);
            let modsText = '';
            if (item.variations && item.variations.length > 0) modsText += item.variations.join(', ');
            if (item.addons && item.addons.length > 0) {
                item.addons.forEach(a => {
                    itemTotal += Number(a.product.price) * a.qty;
                    modsText += (modsText ? ' · ' : '') + `+${a.qty}x ${a.product.name}`;
                });
            }
            const div = document.createElement('div');
            div.style.display = 'flex';
            div.style.justifyContent = 'space-between';
            div.style.alignItems = 'flex-start';
            div.style.fontSize = '0.9rem';
            div.style.paddingBottom = '6px';
            div.style.borderBottom = '1px dashed var(--border-subtle)';
            
            div.innerHTML = `
                <div>
                    <div style="font-weight:700; color:var(--text-main);">${item.quantity}x ${item.product.name}</div>
                    ${modsText ? `<div style="font-size:0.75rem; color:var(--text-muted);">${modsText}</div>` : ''}
                </div>
                <div style="font-family:'Outfit', sans-serif; font-weight:800; color:var(--brand-primary);">
                    R$ ${(itemTotal * item.quantity).toFixed(2).replace('.', ',')}
                </div>
            `;
            list.appendChild(div);
        });
        if (totalDisplay) totalDisplay.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
    }

    function closeCheckoutForm() {
        if (pixPollingInterval) {
            clearInterval(pixPollingInterval);
            pixPollingInterval = null;
        }

        const checkoutModal = document.getElementById('checkout-modal');
        if (checkoutModal) checkoutModal.classList.remove('active');

        const formWrapper = document.getElementById('checkout-form-wrapper');
        const pixScreen = document.getElementById('pix-container');
        const waitingState = document.getElementById('pix-waiting-state');
        const approvedState = document.getElementById('pix-approved-state');

        if (formWrapper) formWrapper.style.display = 'flex';
        if (pixScreen) pixScreen.style.display = 'none';
        if (waitingState) waitingState.style.display = 'block';
        if (approvedState) approvedState.style.display = 'none';

        if (cart.length > 0) {
            const cartModal = document.getElementById('cart-modal');
            if (cartModal) cartModal.classList.add('active');
        }
    }

    function maskPhone(input) {
        let val = input.value.replace(/\D/g, '');
        if (val.length > 11) val = val.slice(0, 11);
        if (val.length > 2) val = `(${val.slice(0, 2)}) ${val.slice(2)}`;
        if (val.length > 10) val = `${val.slice(0, 10)}-${val.slice(10)}`;
        input.value = val;
    }

    function copyPixCode() {
        const input = document.getElementById('pix-copia-cola');
        if (!input || !input.value) return;
        input.select();
        input.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(input.value).then(() => {
            const btn = document.getElementById('btn-copy-pix');
            if (btn) {
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado!';
                btn.classList.add('btn-primary');
                setTimeout(() => {
                    btn.innerHTML = '<i class="fa-regular fa-copy"></i> Copiar';
                }, 2500);
            }
        }).catch(() => {
            alert('Código PIX copiado!');
        });
    }

    // --- Dedução Atômica de Estoque ---
    async function deductStockAtomically() {
        const itemTotals = new Map();
        cart.forEach(entry => {
            const pId = entry.product.id;
            if (!itemTotals.has(pId)) itemTotals.set(pId, 0);
            itemTotals.set(pId, itemTotals.get(pId) + entry.quantity);
            if (entry.addons) {
                entry.addons.forEach(a => {
                    const aId = a.product.id;
                    if (!itemTotals.has(aId)) itemTotals.set(aId, 0);
                    itemTotals.set(aId, itemTotals.get(aId) + (a.qty * entry.quantity));
                });
            }
        });

        const items = Array.from(itemTotals.entries()).map(([id, qty]) => ({ id, qty }));
        
        const client = getSupabaseClient();
        const { data: stockResult, error: stockError } = await client.rpc('deduct_stock_batch', { p_items: items });
        
        if (stockError) {
            console.error('Erro na chamada RPC deduct_stock_batch:', stockError);
            throw new Error('Falha de comunicação ao verificar estoque. Tente novamente.');
        }
        
        if (stockResult && !stockResult.success) {
            await loadProducts(); 
            throw new Error(`Estoque insuficiente para: ${stockResult.failed_product}.`);
        }
        return items; 
    }

    async function restoreStockAtomically(items) {
        if (!items || items.length === 0) return;
        try {
            const client = getSupabaseClient();
            if (client) await client.rpc('restore_stock_batch', { p_items: items });
            await loadProducts(); 
        } catch(e) {
            console.error('Falha ao restaurar estoque após erro de pagamento:', e);
        }
    }

    // --- Salvar Pedido no Supabase ---
    async function saveWebOrder({ id, clientName, clientPhone, observation, paymentStatus, selectedMethod }) {
        const { total } = getCartTotal();

        const items = cart.map(entry => {
            let itemTotal = Number(entry.product.price);
            let addonsDesc = '';
            if (entry.addons && entry.addons.length > 0) {
                entry.addons.forEach(a => {
                    itemTotal += Number(a.product.price) * a.qty;
                    addonsDesc += `\n+ ${a.qty}x ${a.product.name}`;
                });
            }
            let varsDesc = entry.variations && entry.variations.length > 0 ? `\n[${entry.variations.join(', ')}]` : '';
            
            return {
                id: entry.product.id,
                name: entry.product.name + varsDesc + addonsDesc,
                price: itemTotal,
                qty: entry.quantity,
                subtotal: itemTotal * entry.quantity,
                addons: entry.addons,
                variations: entry.variations
            };
        });

        const orderId = id || generateId();
        const order = {
            id: orderId,
            client_name: clientName,
            client_phone: clientPhone,
            items,
            total,
            observation: observation || '',
            status: paymentStatus === 'approved' ? 'pending' : 'waiting_payment',
            payment_method: selectedMethod || 'online',
            payment_status: paymentStatus || 'pending',
            created_at: new Date().toISOString()
        };

        const client = getSupabaseClient();
        const { error } = await client.from('web_orders').insert(order);
        if (error) {
            console.error('Erro ao salvar pedido web:', error.message, error.details, error.hint);
            throw new Error(error.message || JSON.stringify(error));
        }
        
        saveRecentOrderId(orderId);
        return order;
    }

    // --- Polling & Confirmação em Tempo Real do PIX ---
    let pixPollingInterval = null;

    function startCheckingPixStatus(paymentId, orderSummary) {
        if (pixPollingInterval) clearInterval(pixPollingInterval);

        const waitingState = document.getElementById('pix-waiting-state');
        const approvedState = document.getElementById('pix-approved-state');
        if (waitingState) waitingState.style.display = 'block';
        if (approvedState) approvedState.style.display = 'none';

        const client = getSupabaseClient();
        if (client) {
            client.channel(`order-status-${paymentId}`)
                .on('postgres_changes', { 
                    event: 'UPDATE', 
                    schema: 'public', 
                    table: 'web_orders', 
                    filter: `id=eq.${paymentId}` 
                }, payload => {
                    if (payload.new && payload.new.payment_status === 'approved') {
                        onPaymentSuccess(paymentId, orderSummary);
                    }
                })
                .subscribe();
        }

        pixPollingInterval = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/check_payment/${paymentId}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.approved || data.status === 'approved') {
                        onPaymentSuccess(paymentId, orderSummary);
                    }
                }
            } catch (err) {
                console.warn('Polling de pagamento:', err);
            }
        }, 2500);
    }

    function onPaymentSuccess(paymentId, orderSummary) {
        if (pixPollingInterval) {
            clearInterval(pixPollingInterval);
            pixPollingInterval = null;
        }

        lastPlacedOrderId = String(paymentId);
        saveRecentOrderId(paymentId);

        const waitingState = document.getElementById('pix-waiting-state');
        const approvedState = document.getElementById('pix-approved-state');
        const summaryEl = document.getElementById('pix-approved-summary');

        if (waitingState) waitingState.style.display = 'none';
        if (approvedState) approvedState.style.display = 'block';

        if (summaryEl && orderSummary) {
            summaryEl.innerHTML = `
                <div style="font-size: 0.95rem; margin-bottom: 6px;"><strong>Pedido:</strong> #${String(paymentId).slice(-6)}</div>
                <div style="font-size: 0.95rem; margin-bottom: 6px;"><strong>Cliente:</strong> ${orderSummary.clientName}</div>
                <div style="font-size: 0.95rem; margin-bottom: 6px;"><strong>Total Pago:</strong> R$ ${orderSummary.total.toFixed(2).replace('.', ',')}</div>
                <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);">
                    Status: <span style="color: var(--success); font-weight: 800;">✅ Pago & Enviado ao PDV / Cozinha</span>
                </div>
            `;
        }
    }

    function openTrackerFromSuccess() {
        const orderIdToOpen = lastPlacedOrderId;
        closeCheckoutForm();
        openTrackerModal(orderIdToOpen);
    }

    // =========================================================
    // SELETOR E PROCESSAMENTO DE PAGAMENTO (PIX / DÉBITO / CRÉDITO)
    // =========================================================
    function selectPaymentMethod(method) {
        selectedPaymentMethodKey = method;

        document.querySelectorAll('.payment-method-card').forEach(b => b.classList.remove('active'));
        const btnMap = { creditCard: 'btn-pm-credit', debitCard: 'btn-pm-debit', bankTransfer: 'btn-pm-pix' };
        const btnEl = document.getElementById(btnMap[method]);
        if (btnEl) btnEl.classList.add('active');

        const debitBanner = document.getElementById('debit-info-banner');
        const pixContainer = document.getElementById('pix-action-container');
        const walletContainer = document.getElementById('wallet_container');

        if (method === 'bankTransfer') {
            if (debitBanner) debitBanner.style.display = 'none';
            if (walletContainer) { walletContainer.style.display = 'none'; walletContainer.innerHTML = ''; }
            if (pixContainer) pixContainer.style.display = 'block';

            if (paymentBrickController) {
                try { paymentBrickController.unmount(); } catch(e) {}
                paymentBrickController = null;
            }
        } else {
            if (pixContainer) pixContainer.style.display = 'none';
            if (debitBanner) debitBanner.style.display = method === 'debitCard' ? 'flex' : 'none';
            
            if (walletContainer) {
                walletContainer.style.display = 'block';
                walletContainer.innerHTML = '<div style="text-align:center; padding:18px; color:var(--text-muted); font-size:0.88rem;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando formulário seguro do cartão...</div>';
            }
            initCardPaymentBrick(method);
        }
    }

    const API_BASE_URL = window.location.hostname.includes('netlify.app') 
        ? 'https://pdv-sdzo.onrender.com' 
        : '';

    let paymentBrickController = null;

    async function initCardPaymentBrick(paymentMethodFilter) {
        if (!mp) {
            console.warn('MP não inicializado — fallback manual ativo.');
            const payBtn = document.getElementById('btn-pay');
            if (payBtn) payBtn.style.display = 'block';
            return;
        }

        if (paymentBrickController) {
            try { paymentBrickController.unmount(); } catch(e) {}
            paymentBrickController = null;
        }

        const { total } = getCartTotal();
        const container = document.getElementById('wallet_container');
        if (container) container.innerHTML = '';

        try {
            const bricksBuilder = mp.bricks();
            const isDebit = paymentMethodFilter === 'debitCard';

            // Configuração Universal do Card Payment Brick
            // Para Débito: maxInstallments = 1 (à vista em qualquer cartão)
            // Para Crédito: maxInstallments = 12 (parcelamento)
            const settings = {
                initialization: {
                    amount: total,
                },
                customization: {
                    paymentMethods: {
                        maxInstallments: isDebit ? 1 : 12,
                    },
                    visual: {
                        style: {
                            theme: 'dark',
                            customVariables: {
                                formBackgroundColor: '#151d2f',
                                baseColor: '#f59e0b',
                            }
                        }
                    }
                },
                callbacks: {
                    onReady: () => {
                        console.log(`Card Payment Brick pronto (${isDebit ? 'Débito' : 'Crédito'}).`);
                        const payBtn = document.getElementById('btn-pay');
                        if (payBtn) payBtn.style.display = 'none';
                    },

                    onSubmit: async (cardFormData) => {
                        const name = document.getElementById('client-name').value.trim();
                        const lastname = document.getElementById('client-lastname').value.trim();
                        const phone = document.getElementById('client-phone').value.trim();
                        const obs = document.getElementById('client-obs').value.trim();

                        if (!name || !lastname || !phone) {
                            alert('Por favor, preencha os dados de identificação antes de pagar.');
                            return new Promise((resolve, reject) => reject());
                        }

                        let deductedItems = [];
                        try {
                            deductedItems = await deductStockAtomically();
                        } catch(e) {
                            alert('Erro de estoque: ' + (e.message || 'Falha ao reservar estoque.'));
                            return new Promise((resolve, reject) => reject());
                        }

                        try {
                            const response = await fetch(`${API_BASE_URL}/process_payment`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    paymentData: cardFormData,
                                    cart,
                                    clientData: { fullName: `${name} ${lastname}`, phone },
                                    totalAmount: getCartTotal().total
                                }),
                            });

                            const data = await response.json();
                            const paymentOk = response.ok && (data.status === 'approved' || data.status === 'pending');

                            if (paymentOk) {
                                const createdOrder = await saveWebOrder({
                                    id: String(data.id),
                                    clientName: `${name} ${lastname}`,
                                    clientPhone: phone,
                                    observation: obs,
                                    paymentStatus: data.status,
                                    selectedMethod: selectedPaymentMethodKey || (isDebit ? 'debitCard' : 'creditCard')
                                });

                                alert(`✅ Pagamento Aprovado!\nObrigado ${name}, seu pedido foi enviado ao PDV.`);
                                cart = [];
                                updateCartUI();
                                closeCheckoutForm();
                                openTrackerModal(createdOrder.id);
                            } else {
                                await restoreStockAtomically(deductedItems);
                                alert(`Pagamento não aprovado: ${data.status_detail || data.error || 'Verifique os dados do cartão.'}`);
                            }

                        } catch(e) {
                            console.error('Erro no processamento do cartão:', e);
                            await restoreStockAtomically(deductedItems);
                            alert('Erro de conexão ao processar pagamento.');
                            throw e;
                        }
                    },
                    onError: (error) => {
                        console.error('Erro no Card Payment Brick:', error);
                    }
                }
            };

            paymentBrickController = await bricksBuilder.create('cardPayment', 'wallet_container', settings);

        } catch (e) {
            console.error('Erro ao iniciar Card Payment Brick:', e);
            const payBtn = document.getElementById('btn-pay');
            if (payBtn) payBtn.style.display = 'block';
        }
    }

    // --- Processamento do PIX ---
    async function processPixPayment() {
        const name = document.getElementById('client-name').value.trim();
        const lastname = document.getElementById('client-lastname').value.trim();
        const phone = document.getElementById('client-phone').value.trim();
        const obs = document.getElementById('client-obs').value.trim();

        if (!name || !lastname || !phone) {
            alert('Por favor, informe Nome, Sobrenome e WhatsApp antes de gerar o PIX.');
            return;
        }

        const btn = document.getElementById('btn-confirm-pix');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando PIX...';
        }

        let deductedItems = [];
        try {
            deductedItems = await deductStockAtomically();
        } catch(e) {
            alert('Erro de estoque: ' + (e.message || 'Falha ao reservar estoque.'));
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-brands fa-pix"></i> Gerar QR Code PIX'; }
            return;
        }

        try {
            const { total } = getCartTotal();
            const currentTotal = total;
            const response = await fetch(`${API_BASE_URL}/create_pix`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cart,
                    clientData: {
                        fullName: `${name} ${lastname}`,
                        firstName: name,
                        lastName: lastname,
                        phone,
                        email: 'cliente@eduespetinhos.com.br'
                    },
                    totalAmount: total
                }),
            });

            const data = await response.json();

            if (!response.ok || data.error) {
                await restoreStockAtomically(deductedItems);
                alert('Erro ao gerar PIX: ' + (data.error || 'Tente novamente.'));
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-brands fa-pix"></i> Gerar QR Code PIX'; }
                return;
            }

            // Salva pedido em web_orders
            await saveWebOrder({
                id: String(data.payment_id),
                clientName: `${name} ${lastname}`,
                clientPhone: phone,
                observation: obs,
                paymentStatus: 'pending',
                selectedMethod: 'bankTransfer'
            });

            // Transição para tela PIX
            const formWrapper = document.getElementById('checkout-form-wrapper');
            if (formWrapper) formWrapper.style.display = 'none';
            const pixScreen = document.getElementById('pix-container');
            if (pixScreen) pixScreen.style.display = 'flex';

            const qrImg = document.getElementById('pix-qr-img');
            if (qrImg) {
                qrImg.src = data.qr_code_base64 || '';
                qrImg.style.display = data.qr_code_base64 ? 'block' : 'none';
            }

            const copiaCola = document.getElementById('pix-copia-cola');
            if (copiaCola) copiaCola.value = data.qr_code || '';

            startCheckingPixStatus(String(data.payment_id), {
                clientName: `${name} ${lastname}`,
                total: currentTotal
            });

            cart = [];
            updateCartUI();

        } catch(e) {
            console.error('Erro no processPixPayment:', e);
            await restoreStockAtomically(deductedItems);
            alert('Erro de conexão ao gerar PIX.');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-brands fa-pix"></i> Gerar QR Code PIX'; }
        }
    }

    // =========================================================
    // MÓDULO DE ACOMPANHAMENTO DE PEDIDOS (TRACKER)
    // =========================================================
    function openTrackerModal(orderIdToTrack = null) {
        openModal('tracker-modal');
        renderRecentOrdersChips(orderIdToTrack);

        const input = document.getElementById('tracker-search-input');
        if (orderIdToTrack) {
            if (input) input.value = orderIdToTrack;
            searchOrders(orderIdToTrack);
        } else {
            const recent = getRecentOrders();
            if (recent.length > 0) {
                if (input) input.value = recent[0];
                searchOrders(recent[0]);
            }
        }
    }

    function renderRecentOrdersChips(activeId = null) {
        const container = document.getElementById('recent-orders-container');
        const chipsWrap = document.getElementById('recent-orders-chips');
        if (!container || !chipsWrap) return;

        const recent = getRecentOrders();
        if (recent.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        chipsWrap.innerHTML = '';

        recent.forEach(id => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `recent-chip-btn ${activeId === id ? 'active' : ''}`;
            chip.innerHTML = `<i class="fa-solid fa-receipt"></i> #${id.slice(-6)}`;
            chip.onclick = () => {
                const input = document.getElementById('tracker-search-input');
                if (input) input.value = id;
                renderRecentOrdersChips(id);
                searchOrders(id);
            };
            chipsWrap.appendChild(chip);
        });
    }

    async function searchOrders(query) {
        const resultContainer = document.getElementById('tracker-result-container');
        if (!resultContainer) return;

        const cleanQuery = (query || '').trim();
        if (!cleanQuery) {
            resultContainer.innerHTML = `
                <div style="text-align: center; padding: 36px 16px; color: var(--text-muted);">
                    <i class="fa-solid fa-clock-rotate-left" style="font-size: 2.4rem; margin-bottom: 12px; opacity: 0.5;"></i>
                    <p style="font-weight: 700; font-size: 1rem; color: var(--text-secondary);">Consulte seu pedido em tempo real</p>
                    <span style="font-size: 0.85rem;">Digite o WhatsApp informado no pedido para ver o andamento na cozinha.</span>
                </div>
            `;
            return;
        }

        resultContainer.innerHTML = `
            <div style="text-align: center; padding: 36px; color: var(--text-muted);">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--brand-primary); margin-bottom: 12px;"></i>
                <p style="font-weight: 700; font-size: 0.95rem; color: var(--text-secondary);">Buscando pedido...</p>
            </div>
        `;

        try {
            const client = getSupabaseClient();
            if (!client) throw new Error('Falha de conexão.');

            const digitsOnly = cleanQuery.replace(/\D/g, '');
            let orders = [];

            // 1. Busca por ID exato
            const { data: byId } = await client.from('web_orders').select('*').eq('id', cleanQuery);
            if (byId && byId.length > 0) orders.push(...byId);

            // 2. Busca por Telefone
            if (orders.length === 0 && digitsOnly.length >= 6) {
                const { data: byPhone } = await client.from('web_orders').select('*').ilike('client_phone', `%${digitsOnly}%`).order('created_at', { ascending: false }).limit(5);
                if (byPhone && byPhone.length > 0) orders.push(...byPhone);
            }

            // 3. Busca por Like ID
            if (orders.length === 0) {
                const { data: byLikeId } = await client.from('web_orders').select('*').ilike('id', `%${cleanQuery}%`).order('created_at', { ascending: false }).limit(3);
                if (byLikeId && byLikeId.length > 0) orders.push(...byLikeId);
            }

            if (orders.length === 0) {
                resultContainer.innerHTML = `
                    <div style="text-align: center; padding: 36px 16px; color: var(--text-muted);">
                        <i class="fa-solid fa-circle-exclamation" style="font-size: 2.2rem; color: var(--danger); margin-bottom: 12px;"></i>
                        <p style="font-weight: 700; font-size: 1rem; color: var(--text-main);">Nenhum pedido encontrado</p>
                        <span style="font-size: 0.85rem; display: block; margin-top: 4px;">Verifique o número ou código informado e tente novamente.</span>
                    </div>
                `;
                return;
            }

            const order = orders[0];
            const { data: comandaData } = await client.from('comandas').select('*').eq('id', order.id).maybeSingle();
            
            renderOrderStatusCard(order, comandaData);
            setupRealtimeOrderTracker(order.id);

        } catch(err) {
            console.error('Erro na busca de pedidos:', err);
            resultContainer.innerHTML = `
                <div style="text-align: center; padding: 30px; color: var(--danger);">
                    <p style="font-weight: 700;">Erro ao consultar pedido</p>
                    <span style="font-size: 0.85rem; color: var(--text-muted);">${err.message || 'Tente novamente em instantes.'}</span>
                </div>
            `;
        }
    }

    function renderOrderStatusCard(order, comanda) {
        const resultContainer = document.getElementById('tracker-result-container');
        if (!resultContainer) return;

        let currentStatus = order.status || 'pending';
        let isPaid = order.payment_status === 'approved' || (comanda && comanda.paid === true);
        
        if (comanda) {
            if (comanda.status === 'ready') currentStatus = 'ready';
            else if (comanda.status === 'closed') currentStatus = 'closed';
            else if (comanda.status === 'open' && isPaid) currentStatus = 'pending';
        }

        let step = 2; // Default: Na cozinha
        let progressWidth = '45%';
        let statusBadgeText = 'Na Cozinha';

        if (!isPaid && (currentStatus === 'waiting_payment' || order.payment_status === 'pending')) {
            step = 1;
            progressWidth = '15%';
            statusBadgeText = 'Aguardando Pagamento';
        } else if (currentStatus === 'ready') {
            step = 3;
            progressWidth = '75%';
            statusBadgeText = 'Pronto p/ Retirada';
        } else if (currentStatus === 'closed' || currentStatus === 'delivered' || currentStatus === 'done') {
            step = 4;
            progressWidth = '100%';
            statusBadgeText = 'Entregue';
        } else if (currentStatus === 'cancelled' || currentStatus === 'canceled') {
            step = 0;
            progressWidth = '0%';
            statusBadgeText = 'Cancelado';
        } else if (currentStatus === 'cancellation_requested') {
            step = 1;
            progressWidth = '15%';
            statusBadgeText = 'Cancelamento Solicitado';
        }

        const dateObj = new Date(order.created_at || Date.now());
        const timeStr = dateObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dateStr = dateObj.toLocaleDateString('pt-BR');

        let itemsHtml = '';
        const items = Array.isArray(order.items) ? order.items : [];
        items.forEach(it => {
            const qty = it.qty || 1;
            const price = Number(it.price || it.subtotal || 0);
            itemsHtml += `
                <div style="display:flex; justify-content:space-between; font-size:0.85rem; padding:3px 0;">
                    <span><strong>${qty}x</strong> ${it.name || 'Item'}</span>
                    <strong style="color:var(--brand-primary);">R$ ${(price * qty).toFixed(2).replace('.', ',')}</strong>
                </div>
            `;
        });

        resultContainer.innerHTML = `
            <div class="order-tracking-card">
                <div style="display:flex; align-items:center; justify-content:space-between; padding-bottom:12px; border-bottom:1px solid var(--border-subtle);">
                    <div>
                        <div style="font-family:'Outfit', sans-serif; font-size:1.15rem; font-weight:800; color:var(--text-main);">Pedido #${String(order.id).slice(-6)}</div>
                        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;"><i class="fa-regular fa-clock"></i> ${dateStr} às ${timeStr}</div>
                    </div>
                    <span style="padding:6px 12px; border-radius:var(--r-full); font-size:0.75rem; font-weight:800; text-transform:uppercase; background-color:var(--bg-elevated); border:1px solid var(--border-medium); color:var(--brand-primary);">
                        ${statusBadgeText}
                    </span>
                </div>

                <!-- Stepper de 4 Etapas -->
                <div class="order-timeline-stepper">
                    <div class="stepper-progress-fill" style="width: ${progressWidth};"></div>
                    
                    <div class="timeline-step ${step >= 1 ? (step === 1 ? 'active' : 'completed') : ''}">
                        <div class="timeline-circle"><i class="fa-solid fa-receipt"></i></div>
                        <span class="timeline-caption">Recebido</span>
                    </div>
                    <div class="timeline-step ${step >= 2 ? (step === 2 ? 'active' : 'completed') : ''}">
                        <div class="timeline-circle"><i class="fa-solid fa-fire-burner"></i></div>
                        <span class="timeline-caption">Na Cozinha</span>
                    </div>
                    <div class="timeline-step ${step >= 3 ? (step === 3 ? 'active' : 'completed') : ''}">
                        <div class="timeline-circle"><i class="fa-solid fa-bell"></i></div>
                        <span class="timeline-caption">Pronto</span>
                    </div>
                    <div class="timeline-step ${step >= 4 ? 'completed' : ''}">
                        <div class="timeline-circle"><i class="fa-solid fa-check"></i></div>
                        <span class="timeline-caption">Entregue</span>
                    </div>
                </div>

                ${currentStatus === 'ready' ? `
                    <div style="background-color:var(--success-light); border:1.5px solid var(--success-border); border-radius:var(--r-md); padding:12px; text-align:center; color:var(--success); font-weight:800;">
                        <i class="fa-solid fa-bell" style="margin-right:6px;"></i>
                        SEU PEDIDO ESTÁ PRONTO! PODE RETIRAR NO BALCÃO!
                    </div>
                ` : ''}

                <!-- Detalhes do Pedido -->
                <div style="background-color:var(--bg-input); border:1px solid var(--border-subtle); border-radius:var(--r-md); padding:14px; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between; font-size:0.85rem; color:var(--text-secondary);">
                        <span>Cliente:</span>
                        <strong style="color:var(--text-main);">${order.client_name || 'Cliente'}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:0.85rem; color:var(--text-secondary);">
                        <span>WhatsApp:</span>
                        <strong style="color:var(--text-main);">${order.client_phone || '-'}</strong>
                    </div>
                    ${order.observation ? `
                    <div style="display:flex; justify-content:space-between; font-size:0.85rem; color:var(--text-secondary);">
                        <span>Obs:</span>
                        <strong style="color:var(--text-muted);">${order.observation}</strong>
                    </div>` : ''}
                    
                    <div style="margin-top:6px; padding-top:6px; border-top:1px dashed var(--border-subtle);">
                        ${itemsHtml}
                    </div>

                    <div style="margin-top:6px; padding-top:8px; border-top:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-weight:700; color:var(--text-main);">Total:</span>
                        <strong style="font-family:'Outfit', sans-serif; font-size:1.25rem; color:var(--brand-primary);">R$ ${Number(order.total || 0).toFixed(2).replace('.', ',')}</strong>
                    </div>
                </div>

                <div style="display:flex; align-items:center; justify-content:center; gap:8px; font-size:0.78rem; color:var(--info);">
                    <i class="fa-solid fa-circle-dot fa-beat"></i>
                    <span>Atualizando em tempo real com a cozinha</span>
                </div>
                
                ${(currentStatus !== 'cancelled' && currentStatus !== 'canceled' && currentStatus !== 'closed' && currentStatus !== 'delivered' && currentStatus !== 'done' && currentStatus !== 'cancellation_requested') ? `
                    <button onclick="pedidoApp.requestCancellation('${order.id}', ${isPaid})" style="margin-top:16px; width:100%; padding:12px; border-radius:8px; border:1px solid rgba(239, 68, 68, 0.3); background:transparent; color:#ef4444; font-weight:700; cursor:pointer;">
                        <i class="fa-solid fa-ban"></i> Solicitar Cancelamento
                    </button>
                ` : ''}
            </div>
        `;
    }

    async function requestCancellation(orderId, isPaid) {
        if (!confirm('Tem certeza que deseja cancelar este pedido?')) return;
        
        showLoading();
        try {
            const client = getSupabaseClient();
            if (!client) throw new Error('Falha de conexão.');

            if (!isPaid) {
                // Cancelamento imediato
                const { data: order } = await client.from('web_orders').select('*').eq('id', orderId).single();
                if (order && order.items) {
                    const itemsToRestore = order.items.map(it => ({ id: it.productId || it.id, qty: it.qty }));
                    await restoreStockAtomically(itemsToRestore);
                }
                await client.from('web_orders').update({ status: 'cancelled' }).eq('id', orderId);
                alert('Pedido cancelado com sucesso!');
            } else {
                // Solicitar aprovação
                await client.from('web_orders').update({ status: 'cancellation_requested' }).eq('id', orderId);
                alert('Solicitação de cancelamento enviada ao restaurante.');
            }
        } catch (err) {
            console.error('Erro ao cancelar:', err);
            alert('Não foi possível solicitar o cancelamento agora. ' + err.message);
        } finally {
            hideLoading();
            searchOrder(); // Atualiza a tela de rastreio
        }
    }

    function setupRealtimeOrderTracker(orderId) {
        const client = getSupabaseClient();
        if (!client || !orderId) return;

        if (trackerRealtimeChannel) {
            client.removeChannel(trackerRealtimeChannel);
        }

        trackerRealtimeChannel = client.channel(`tracker-order-${orderId}`)
            .on('postgres_changes', { 
                event: 'UPDATE', 
                schema: 'public', 
                table: 'web_orders', 
                filter: `id=eq.${orderId}` 
            }, async payload => {
                const { data: comanda } = await client.from('comandas').select('*').eq('id', orderId).maybeSingle();
                renderOrderStatusCard(payload.new, comanda);
            })
            .on('postgres_changes', { 
                event: 'UPDATE', 
                schema: 'public', 
                table: 'comandas', 
                filter: `id=eq.${orderId}` 
            }, async payload => {
                const { data: webOrder } = await client.from('web_orders').select('*').eq('id', orderId).maybeSingle();
                if (webOrder) renderOrderStatusCard(webOrder, payload.new);
            })
            .subscribe();
    }

    // --- Inicialização Automática ---
    window.addEventListener('DOMContentLoaded', () => {
        loadProducts();
    });

    // Public API
    return {
        openCustomizeModal,
        closeModal,
        addSelectedAddon,
        updateCustomizeAddonQty,
        updateCustomizeQty,
        confirmCustomization,
        updateCartIndex,
        clearEntireCart,
        toggleCart,
        openCheckoutForm,
        closeCheckoutForm,
        proceedToPaymentStep,
        backToDetailsStep,
        maskPhone,
        requestCancellation,
        selectPaymentMethod,
        processPixPayment,
        copyPixCode,
        filterSearch,
        clearSearch,
        openTrackerModal,
        openTrackerFromSuccess,
        searchOrders
    };
})();
