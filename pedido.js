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

    // --- Load Products from Supabase ---
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

            // Filter out raw materials (Insumos)
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

    // --- Realtime Stock Updates ---
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
                    updateCartUI(); // Validate cart against new stock
                }
            })
            .subscribe();
    }

    // --- Search Filter ---
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

    // --- Render Categories ---
    function renderCategories() {
        const container = document.getElementById('categories-nav');
        if (!container) return;
        container.innerHTML = '';

        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = `cat-btn ${currentCategory === cat ? 'active' : ''}`;
            
            // Icon according to category
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

    // --- Render Products ---
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
                    <p style="font-weight: 600; font-size: 1rem; color: var(--text-secondary);">Nenhum produto encontrado</p>
                    <span style="font-size: 0.85rem;">Tente buscar por outro termo ou categoria</span>
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
                badgeHtml = `<span class="product-badge badge-esgotado">Esgotado</span>`;
            } else if (isLowStock) {
                badgeHtml = `<span class="product-badge badge-ultimas">Últimas ${stock}</span>`;
            }

            let actionHtml = '';
            if (isOutOfStock) {
                actionHtml = `<span class="esgotado-label">Indisponível</span>`;
            } else if (qty > 0) {
                actionHtml = `
                    <button class="btn-add-product has-qty" onclick="pedidoApp.openCustomizeModal('${p.id}')" title="Alterar ou adicionar mais">
                        <i class="fa-solid fa-check"></i> ${qty}
                    </button>
                `;
            } else {
                actionHtml = `
                    <button class="btn-add-product" onclick="pedidoApp.openCustomizeModal('${p.id}')" title="Adicionar">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                `;
            }

            card.innerHTML = `
                <div class="product-card-top">
                    <div class="product-badges-row">
                        <span class="product-category-tag">${p.category || 'Geral'}</span>
                        ${badgeHtml}
                    </div>
                    <div class="product-name">${p.name}</div>
                </div>
                <div class="product-footer">
                    <div class="product-price">R$ ${Number(p.price).toFixed(2).replace('.', ',')}</div>
                    ${actionHtml}
                </div>
            `;
            container.appendChild(card);
        });
    }

    // --- Customization Modals ---
    function openModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.add('active');
    }

    function closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.remove('active');
    }

    function openCustomizeModal(productId) {
        const prod = products.find(p => p.id === productId);
        if (!prod) return;

        currentCustomizeProduct = prod;
        currentCustomizeVariations = [];
        currentCustomizeAddons = [];
        
        // Defaults for variations based on category
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
            donenessContainer.style.display = isBebida ? 'none' : 'block';
        }

        const addonsContainer = document.getElementById('customize-addons-container');
        if (addonsContainer) {
            addonsContainer.style.display = isLanche ? 'block' : 'none';
        }

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
                btn.className = `var-btn ${isSelected ? 'selected' : ''}`;
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
            extrasContainer.style.display = 'block';
        }
        const extrasList = document.getElementById('customize-variations-extras-list');
        if (extrasList) {
            extrasList.innerHTML = '';
            VARIATIONS_EXTRAS.forEach(vari => {
                const isSelected = currentCustomizeVariations.includes(vari);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `var-btn ${isSelected ? 'selected' : ''}`;
                btn.textContent = vari;
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
            div.style.display = 'flex';
            div.style.justifyContent = 'space-between';
            div.style.alignItems = 'center';
            div.style.background = 'var(--bg-elevated)';
            div.style.padding = '8px 12px';
            div.style.borderRadius = 'var(--r-md)';
            div.style.border = '1px solid var(--border)';
            
            div.innerHTML = `
                <div>
                    <div style="font-weight: 600; font-size: 0.9rem;">${a.product.name}</div>
                    <div style="color: var(--success); font-size: 0.8rem; font-weight: 700;">+ R$ ${Number(a.product.price).toFixed(2).replace('.', ',')}</div>
                </div>
                <div class="qty-controls" style="display: flex; align-items: center; gap: 8px;">
                    <button type="button" class="qty-btn" onclick="pedidoApp.updateCustomizeAddonQty('${a.product.id}', -1)">-</button>
                    <span class="qty-value">${a.qty}</span>
                    <button type="button" class="qty-btn" onclick="pedidoApp.updateCustomizeAddonQty('${a.product.id}', 1)">+</button>
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

    // --- Cart Management ---
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
            if (getCartTotal().count > 0) {
                renderCartModal();
                modal.classList.add('active');
            }
        }
    }

    function renderCartModal() {
        const container = document.getElementById('cart-items');
        const totalModal = document.getElementById('cart-total-modal');
        const cartFooter = document.getElementById('cart-footer');
        const { total, count } = getCartTotal();

        if (!container) return;
        container.innerHTML = '';

        if (count === 0) {
            container.innerHTML = `
                <div class="empty-cart">
                    <i class="fa-solid fa-bag-shopping empty-cart-icon"></i>
                    <p>Sua sacola está vazia</p>
                    <span>Escolha itens deliciosos do nosso cardápio!</span>
                </div>`;
            if (totalModal) totalModal.textContent = 'R$ 0,00';
            if (cartFooter) cartFooter.style.display = 'none';
            const btn = document.getElementById('btn-proceed-checkout');
            if (btn) btn.disabled = true;
            return;
        }

        const btn = document.getElementById('btn-proceed-checkout');
        if (btn) btn.disabled = false;
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
            div.className = 'cart-item';
            div.innerHTML = `
                <div class="cart-item-info">
                    <div class="cart-item-name">${item.product.name}</div>
                    ${modsText ? `<div class="cart-item-mods">${modsText}</div>` : ''}
                    <div class="cart-item-price">R$ ${Number(itemTotal * item.quantity).toFixed(2).replace('.', ',')}</div>
                </div>
                <div class="cart-item-controls">
                    <button class="qty-btn remove-btn" onclick="pedidoApp.updateCartIndex(${index}, -1)" aria-label="Remover">
                        <i class="fa-solid ${item.quantity === 1 ? 'fa-trash' : 'fa-minus'}"></i>
                    </button>
                    <span class="qty-value">${item.quantity}</span>
                    <button class="qty-btn" onclick="pedidoApp.updateCartIndex(${index}, 1)" aria-label="Adicionar">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            `;
            container.appendChild(div);
        });
    }

    // --- Checkout Form ---
    function openCheckoutForm() {
        document.getElementById('cart-modal').classList.remove('active');
        document.getElementById('checkout-modal').classList.add('active');

        // Reset estado
        document.getElementById('payment-method-selector').style.display = '';
        document.getElementById('wallet_container').style.display = 'none';
        document.getElementById('wallet_container').innerHTML = '';
        document.getElementById('pix-action-container').style.display = 'none';
        document.getElementById('pix-container').style.display = 'none';
        
        const formWrapper = document.getElementById('checkout-form-wrapper');
        if (formWrapper) formWrapper.style.display = 'flex';
        
        const payBtn = document.getElementById('btn-pay');
        if (payBtn) payBtn.style.display = 'none';
        
        document.querySelectorAll('.payment-method-btn').forEach(b => b.classList.remove('active'));
        selectedPaymentMethodKey = null;

        if (paymentBrickController) {
            try { paymentBrickController.unmount(); } catch(e) {}
            paymentBrickController = null;
        }

        renderCheckoutSummary();
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
            div.className = 'checkout-item';
            div.innerHTML = `
                <div>
                    <div class="checkout-item-name">${item.product.name}</div>
                    ${modsText ? `<div class="checkout-item-mods">${modsText}</div>` : ''}
                    <div class="checkout-item-qty">${item.quantity} unidade(s)</div>
                </div>
                <div class="checkout-item-price">R$ ${(itemTotal * item.quantity).toFixed(2).replace('.', ',')}</div>
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

        if (formWrapper) formWrapper.style.display = 'block';
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
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = '<i class="fa-regular fa-copy"></i> Copiar';
                    btn.classList.remove('copied');
                }, 2500);
            }
        }).catch(() => {
            alert('Código PIX copiado!');
        });
    }

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

        const items = Array.from(itemTotals.entries()).map(([id, qty]) => ({
            id,
            qty
        }));
        
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

    // --- Save Web Order to Supabase ---
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

        const order = {
            id: id || generateId(),
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

        // 1. Escuta em tempo real no Supabase
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

        // 2. Polling ativo a cada 2.5 segundos no backend
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

        const waitingState = document.getElementById('pix-waiting-state');
        const approvedState = document.getElementById('pix-approved-state');
        const summaryEl = document.getElementById('pix-approved-summary');

        if (waitingState) waitingState.style.display = 'none';
        if (approvedState) approvedState.style.display = 'block';

        if (summaryEl && orderSummary) {
            summaryEl.innerHTML = `
                <div style="font-size: 1rem; margin-bottom: 8px;"><strong>Pedido:</strong> #${String(paymentId).slice(-6)}</div>
                <div style="font-size: 1rem; margin-bottom: 8px;"><strong>Cliente:</strong> ${orderSummary.clientName}</div>
                <div style="font-size: 1rem; margin-bottom: 8px;"><strong>Total Pago:</strong> R$ ${orderSummary.total.toFixed(2).replace('.', ',')}</div>
                <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);">Status: <span style="color: #10b981; font-weight: 800;">✅ Pago & Enviado à Cozinha</span></div>
            `;
        }
    }

    // --- Seletor de Método de Pagamento ---
    let selectedPaymentMethodKey = null;

    function selectPaymentMethod(method) {
        const name = document.getElementById('client-name').value.trim();
        const lastname = document.getElementById('client-lastname').value.trim();
        const phone = document.getElementById('client-phone').value.trim();
        
        if (!name || !lastname || !phone) {
            alert('Por favor, preencha Nome, Sobrenome e WhatsApp antes de selecionar a forma de pagamento.');
            return;
        }

        selectedPaymentMethodKey = method;

        // Destaca o botão ativo
        document.querySelectorAll('.payment-method-btn').forEach(b => b.classList.remove('active'));
        const btnMap = { creditCard: 'btn-pm-credit', debitCard: 'btn-pm-debit', bankTransfer: 'btn-pm-pix' };
        const btnEl = document.getElementById(btnMap[method]);
        if (btnEl) btnEl.classList.add('active');

        if (method === 'bankTransfer') {
            // PIX: mostra painel de confirmação direto
            document.getElementById('wallet_container').style.display = 'none';
            document.getElementById('wallet_container').innerHTML = '';
            document.getElementById('pix-action-container').style.display = 'block';
            if (paymentBrickController) {
                try { paymentBrickController.unmount(); } catch(e) {}
                paymentBrickController = null;
            }
        } else {
            // Cartão de Crédito ou Débito: usa o Card Payment Brick universal
            document.getElementById('pix-action-container').style.display = 'none';
            const container = document.getElementById('wallet_container');
            container.style.display = 'block';
            container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 0.9rem;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando formulário seguro do cartão...</div>';
            initCardPaymentBrick(method);
        }
    }

    // API Base URL (Render em produção ou relativo em local)
    const API_BASE_URL = window.location.hostname.includes('netlify.app') 
        ? 'https://pdv-sdzo.onrender.com' 
        : '';

    // --- Mercado Pago Card Payment Brick (Universal para Crédito e Débito) ---
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
            
            // Configuração do Card Payment Brick:
            // Para Débito: maxInstallments = 1 (à vista em qualquer bandeira)
            // Para Crédito: maxInstallments = 12 (parcelamento)
            const isDebit = paymentMethodFilter === 'debitCard';

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
                                formBackgroundColor: '#151c2e',
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
                            alert('Por favor, preencha os dados do cliente.');
                            return new Promise((resolve, reject) => reject());
                        }

                        let deductedItems = [];
                        try {
                            deductedItems = await deductStockAtomically();
                        } catch(e) {
                            alert('Erro: ' + (e.message || 'Falha de estoque'));
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
                                await saveWebOrder({
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
                            } else {
                                await restoreStockAtomically(deductedItems);
                                alert(`Pagamento não aprovado: ${data.status_detail || data.error || 'Tente novamente.'}`);
                            }

                        } catch(e) {
                            console.error(e);
                            await restoreStockAtomically(deductedItems);
                            alert('Erro ao comunicar com o servidor de pagamento.');
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

    // --- Fluxo PIX Direto ---
    async function processPixPayment() {
        const name = document.getElementById('client-name').value.trim();
        const lastname = document.getElementById('client-lastname').value.trim();
        const phone = document.getElementById('client-phone').value.trim();
        const obs = document.getElementById('client-obs').value.trim();

        if (!name || !lastname || !phone) {
            alert('Por favor, preencha Nome, Sobrenome e WhatsApp antes de gerar o PIX.');
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
            alert('Erro: ' + (e.message || 'Falha de estoque'));
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

            // 1. Salva o pedido no Supabase
            await saveWebOrder({
                id: String(data.payment_id),
                clientName: `${name} ${lastname}`,
                clientPhone: phone,
                observation: obs,
                paymentStatus: 'pending',
                selectedMethod: 'bankTransfer'
            });

            // 2. Transiciona para a tela PIX
            const formWrapper = document.getElementById('checkout-form-wrapper');
            if (formWrapper) formWrapper.style.display = 'none';
            const pixScreen = document.getElementById('pix-container');
            if (pixScreen) pixScreen.style.display = 'flex';

            // 3. Preenche QR Code e Copia e Cola
            const qrImg = document.getElementById('pix-qr-img');
            if (qrImg) {
                qrImg.src = data.qr_code_base64 || '';
                qrImg.style.display = data.qr_code_base64 ? 'block' : 'none';
            }

            const copiaCola = document.getElementById('pix-copia-cola');
            if (copiaCola) copiaCola.value = data.qr_code || '';

            // 4. Inicia escuta em tempo real
            startCheckingPixStatus(String(data.payment_id), {
                clientName: `${name} ${lastname}`,
                total: currentTotal
            });

            cart = [];
            updateCartUI();

        } catch(e) {
            console.error('Erro no processPixPayment:', e);
            await restoreStockAtomically(deductedItems);
            alert('Erro ao comunicar com o servidor de pagamento.');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-brands fa-pix"></i> Gerar QR Code PIX'; }
        }
    }

    // --- Fallback manual ---
    async function processCheckout(event) {
        event.preventDefault();

        const name = document.getElementById('client-name').value.trim();
        const lastname = document.getElementById('client-lastname').value.trim();
        const phone = document.getElementById('client-phone').value.trim();
        const obs = document.getElementById('client-obs').value.trim();

        if (!name || !lastname || !phone) {
            alert('Por favor, preencha todos os campos obrigatórios.');
            return;
        }

        const btn = document.getElementById('btn-pay');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';
        }

        let deductedItems = [];
        try {
            deductedItems = await deductStockAtomically();

            await saveWebOrder({
                clientName: `${name} ${lastname}`,
                clientPhone: phone,
                observation: obs,
                paymentStatus: 'manual'
            });

            alert(`✅ Pedido enviado!\nObrigado ${name}, o PDV já recebeu seu pedido.`);
            cart = [];
            updateCartUI();
            closeCheckoutForm();
        } catch(e) {
            console.error('Erro no processCheckout:', e);
            await restoreStockAtomically(deductedItems);
            alert('Erro ao enviar pedido.\n\nDetalhes: ' + (e.message || e));
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-credit-card"></i> Confirmar pedido';
            }
        }
    }

    // --- Inicialização ---
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
        toggleCart,
        openCheckoutForm,
        closeCheckoutForm,
        maskPhone,
        processCheckout,
        selectPaymentMethod,
        processPixPayment,
        copyPixCode,
        filterSearch,
        clearSearch
    };
})();
