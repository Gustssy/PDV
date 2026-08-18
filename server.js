const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname)));

const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: "Muitas tentativas de pagamento." },
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const mpClient = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

function generateId() {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Gera QR Code em Base64 a partir do payload textual PIX
async function generateQRCodeBase64(pixPayload) {
    try {
        const qrBase64 = await QRCode.toDataURL(pixPayload, {
            errorCorrectionLevel: 'M',
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        });
        return qrBase64; // já inclui "data:image/png;base64,..."
    } catch (e) {
        console.error("Erro ao gerar QR Code:", e);
        return null;
    }
}

// Helper: formata cart array para comandaItems
function formatCartToComandaItems(cart) {
    const items = Array.isArray(cart) ? cart : Object.values(cart);
    return items.map(item => {
        let itemPrice = Number(item.product.price);
        if (item.addons && item.addons.length > 0) {
            item.addons.forEach(a => { itemPrice += Number(a.product.price) * a.qty; });
        }
        let name = item.product.name;
        if (item.variations && item.variations.length > 0) name += ` [${item.variations.join(', ')}]`;
        if (item.addons && item.addons.length > 0) {
            item.addons.forEach(a => { name += `\n+ ${a.qty}x ${a.product.name}`; });
        }
        return {
            id: generateId(),
            productId: item.product.id,
            name,
            price: itemPrice,
            qty: item.quantity,
            total: itemPrice * item.quantity,
            category: item.product.category,
            isComposed: item.product.iscomposed || false,
            composition: item.product.composition || []
        };
    });
}

// ROTA: PROCESSAR PAGAMENTO (Cartão de Crédito/Débito via Brick)
app.post("/process_payment", paymentLimiter, async (req, res) => {
    try {
        const { paymentData, cart, clientData, totalAmount } = req.body;

        if (!cart || !clientData || !paymentData) {
            return res.status(400).json({ error: "Dados incompletos." });
        }

        console.log(`Processando pagamento de R$ ${totalAmount} para ${clientData.fullName}`);

        const payment = new Payment(mpClient);
        const response = await payment.create({
            body: {
                ...paymentData,
                transaction_amount: Number(totalAmount),
                description: `Pedido PDV Edu Espetinhos`,
                payer: {
                    email: paymentData.payer?.email || "cliente@eduespetinhos.com.br",
                    identification: paymentData.payer?.identification || undefined,
                }
            },
            requestOptions: { idempotencyKey: uuidv4() }
        });

        console.log("Resposta Mercado Pago:", response.status, response.id);

        const comandaItems = formatCartToComandaItems(cart);
        const newComanda = {
            id: String(response.id),
            status: 'open',
            client: clientData.fullName + ' - ' + clientData.phone,
            date: new Date().toISOString(),
            items: comandaItems,
            total: totalAmount,
            paid: response.status === 'approved',
            ispageless: true,
            paymentmethod: 'Mercado Pago (Site)'
        };

        const { error: dbError } = await supabase.from('comandas').insert([newComanda]);
        if (dbError) console.error("Erro ao salvar comanda:", dbError);
        else console.log("Comanda criada com sucesso no Supabase.");

        return res.json({
            status: response.status,
            status_detail: response.status_detail,
            id: response.id,
            point_of_interaction: response.point_of_interaction || null,
        });

    } catch (err) {
        console.error("Erro ao processar pagamento:", err);
        return res.status(500).json({ error: "Erro interno ao processar pagamento." });
    }
});

// Helper: Finaliza e cria comanda somente quando o pagamento for aprovado
async function finalizePaidOrder(paymentId) {
    try {
        const payment = new Payment(mpClient);
        const mpPayment = await payment.get({ id: String(paymentId) });

        if (!mpPayment || mpPayment.status !== 'approved') {
            return { approved: false, status: mpPayment?.status || 'unknown' };
        }

        const mpId = String(mpPayment.id);
        console.log(`✅ Pagamento ${mpId} confirmado como APROVADO.`);

        // 1. Busca dados do pedido em web_orders
        const { data: webOrder, error: findErr } = await supabase
            .from("web_orders")
            .select("*")
            .eq("id", mpId)
            .maybeSingle();

        if (findErr) console.error("Erro ao buscar web_order:", findErr);

        // 2. Atualiza web_orders para aprovado e pending (pronto para cozinha no PDV)
        await supabase
            .from("web_orders")
            .update({ status: 'pending', payment_status: 'approved' })
            .eq("id", mpId);

        // 3. Verifica se a comanda já foi criada para evitar duplicados
        const { data: existingComanda } = await supabase
            .from("comandas")
            .select("id")
            .eq("id", mpId)
            .maybeSingle();

        if (!existingComanda && webOrder) {
            const comandaItems = formatCartToComandaItems(webOrder.items || []);
            const newComanda = {
                id: mpId,
                status: 'open',
                client: `${webOrder.client_name} - ${webOrder.client_phone}`,
                date: new Date().toISOString(),
                items: comandaItems,
                total: webOrder.total,
                paid: true,
                ispageless: true,
                paymentmethod: 'PIX (Site)'
            };

            const { error: dbError } = await supabase.from("comandas").insert([newComanda]);
            if (dbError) console.error("Erro ao criar comanda paga no Supabase:", dbError);
            else console.log(`🚀 Comanda ${mpId} criada no PDV com status PAGO!`);
        }

        return { approved: true, status: 'approved' };
    } catch (err) {
        console.error("Erro ao finalizar pedido pago:", err?.message || err);
        return { approved: false, error: err?.message };
    }
}

// ROTA: CRIAR PAGAMENTO PIX (gera QR Code imediatamente, NÃO envia ao PDV ainda)
app.post("/create_pix", paymentLimiter, async (req, res) => {
    try {
        const { cart, clientData, totalAmount } = req.body;

        if (!cart || !clientData || !totalAmount) {
            return res.status(400).json({ error: "Dados incompletos." });
        }

        const roundedAmount = Math.round(Number(totalAmount) * 100) / 100;
        console.log(`Criando PIX de R$ ${roundedAmount} para ${clientData.fullName}`);

        // Data de expiração: 24 horas a partir de agora
        const expiration = new Date();
        expiration.setHours(expiration.getHours() + 24);

        const payment = new Payment(mpClient);
        const response = await payment.create({
            body: {
                transaction_amount: roundedAmount,
                description: "Pedido Edu Espetinhos",
                payment_method_id: "pix",
                date_of_expiration: expiration.toISOString(),
                payer: {
                    email: clientData.email || "cliente@eduespetinhos.com.br",
                    first_name: clientData.firstName || (clientData.fullName || "").split(" ")[0] || "Cliente",
                    last_name: clientData.lastName || ((clientData.fullName || "").split(" ").slice(1).join(" ") || "Site"),
                }
            },
            requestOptions: { idempotencyKey: uuidv4() }
        });

        console.log("PIX gerado — Status:", response.status, "| ID:", response.id);

        if (response.status !== 'pending' || !response.point_of_interaction) {
            console.error("PIX falhou. Detalhes:", response.status_detail);
            return res.status(400).json({
                error: `Falha ao gerar PIX: ${response.status_detail || response.status || "status inesperado"}`
            });
        }

        const pixTextCode = response.point_of_interaction.transaction_data?.qr_code;
        const pixBase64FromMP = response.point_of_interaction.transaction_data?.qr_code_base64;

        if (!pixTextCode) {
            return res.status(400).json({ error: "PIX gerado sem código Copia e Cola." });
        }

        // Gera QR Code localmente
        const localQRBase64 = await generateQRCodeBase64(pixTextCode);

        // Retorna dados do PIX sem criar comanda no PDV antes do pagamento
        return res.json({
            status: response.status,
            payment_id: response.id,
            qr_code: pixTextCode,
            qr_code_base64: localQRBase64,
            mp_qr_base64: pixBase64FromMP || null,
            expires_at: expiration.toISOString(),
        });

    } catch (err) {
        console.error("Erro ao criar PIX:", err?.message || err);
        return res.status(500).json({ error: "Erro interno ao gerar PIX. Verifique as credenciais do Mercado Pago." });
    }
});

// ROTA: CONSULTAR STATUS DO PAGAMENTO (Frontend polling em tempo real)
app.get("/check_payment/:id", async (req, res) => {
    try {
        const paymentId = req.params.id;
        if (!paymentId) return res.status(400).json({ error: "ID obrigatório" });

        const result = await finalizePaidOrder(paymentId);
        return res.json(result);
    } catch (err) {
        console.error("Erro no check_payment:", err?.message || err);
        return res.json({ approved: false, status: 'pending' });
    }
});

// ROTA: WEBHOOK / IPN DO MERCADO PAGO
app.all("/webhook/mercadopago", express.json(), async (req, res) => {
    try {
        const body = req.body || {};
        const query = req.query || {};

        const topic = query.topic || query.type || body.type || body.action;
        const paymentId = query.id || query["data.id"] || body.data?.id;

        console.log(`Notificação MP recebida - Topic: ${topic}, ID: ${paymentId}`);

        if (paymentId) {
            await finalizePaidOrder(paymentId);
        }

        return res.status(200).json({ status: "ok" });
    } catch (err) {
        console.error("Erro no webhook:", err?.message || err);
        return res.status(200).json({ status: "error_handled" });
    }
});

app.listen(port, () => {
    console.log(`🚀 PDV Backend Server rodando na porta ${port}`);
});
