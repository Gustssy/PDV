-- Criação da tabela de Produtos
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    sku TEXT,
    category TEXT,
    name TEXT NOT NULL,
    price NUMERIC NOT NULL,
    stock NUMERIC DEFAULT 0,
    isComposed BOOLEAN DEFAULT FALSE,
    composition JSONB DEFAULT '[]'::jsonb,
    isRawMaterial BOOLEAN DEFAULT FALSE,
    unit TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Criação da tabela de Clientes
CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    complement TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Criação da tabela de Comandas (Pagers)
CREATE TABLE comandas (
    id TEXT PRIMARY KEY,
    number INTEGER,
    status TEXT DEFAULT 'open',
    client TEXT,
    date TIMESTAMPTZ DEFAULT NOW(),
    items JSONB DEFAULT '[]'::jsonb,
    total NUMERIC DEFAULT 0,
    paid BOOLEAN DEFAULT FALSE,
    ispageless BOOLEAN DEFAULT FALSE,
    paymentmethod TEXT,
    isfeirante BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Criação da tabela de Vendas
CREATE TABLE sales (
    id TEXT PRIMARY KEY,
    type TEXT,
    date TIMESTAMPTZ DEFAULT NOW(),
    total NUMERIC DEFAULT 0,
    items JSONB DEFAULT '[]'::jsonb,
    paymentmethod TEXT,
    comanda TEXT,
    client TEXT,
    feiralocation TEXT,
    isviagem BOOLEAN DEFAULT FALSE,
    isfeirante BOOLEAN DEFAULT FALSE,
    iscanceled BOOLEAN DEFAULT FALSE,
    received NUMERIC DEFAULT 0,
    change NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Configuração do Real-time para manter as telas sincronizadas instantaneamente
ALTER PUBLICATION supabase_realtime ADD TABLE comandas;
ALTER PUBLICATION supabase_realtime ADD TABLE sales;
ALTER PUBLICATION supabase_realtime ADD TABLE products;
ALTER PUBLICATION supabase_realtime ADD TABLE clients;

-- Garante que não existam dois pagers físicos com o mesmo número abertos simultaneamente
CREATE UNIQUE INDEX unique_active_pager ON comandas (number) WHERE status = 'open' AND ispageless = FALSE;
