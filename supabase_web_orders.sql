-- Criação da tabela de Pedidos Web
CREATE TABLE web_orders (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_phone TEXT NOT NULL,
    items JSONB NOT NULL DEFAULT '[]',
    total NUMERIC NOT NULL DEFAULT 0,
    observation TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT DEFAULT 'online',
    payment_status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilita Realtime para que o PDV receba os pedidos em tempo real
ALTER PUBLICATION supabase_realtime ADD TABLE web_orders;

-- Desativa RLS para permitir inserts do cliente (igual às outras tabelas do projeto)
ALTER TABLE web_orders DISABLE ROW LEVEL SECURITY;
