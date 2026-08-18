-- =====================================================================
-- ESTOQUE CENTRALIZADO — Função RPC de baixa atômica
-- Execute este SQL no painel do Supabase (SQL Editor)
-- =====================================================================

CREATE OR REPLACE FUNCTION deduct_stock_batch(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_item        jsonb;
    v_product_id  text;
    v_qty         numeric;
    v_stock       numeric;
    v_name        text;
    v_is_composed boolean;
BEGIN
    -- FASE 1: Validação + bloqueio (SELECT FOR UPDATE)
    -- Garante atomicidade: nenhuma transação concorrente altera o estoque
    -- enquanto validamos — elimina race conditions.
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_product_id  := v_item->>'id';
        v_qty         := (v_item->>'qty')::numeric;

        SELECT stock, name, COALESCE(iscomposed, false)
          INTO v_stock, v_name, v_is_composed
          FROM products
         WHERE id = v_product_id
           FOR UPDATE;

        -- Produtos compostos: estoque gerenciado pelo PDV via ingredientes
        CONTINUE WHEN v_is_composed;

        IF v_stock IS NULL THEN
            RETURN jsonb_build_object(
                'success',        false,
                'reason',         'Produto nao encontrado',
                'failed_product', v_product_id
            );
        END IF;

        IF v_stock < v_qty THEN
            RETURN jsonb_build_object(
                'success',        false,
                'reason',         'Estoque insuficiente',
                'failed_product', v_name,
                'available',      v_stock,
                'requested',      v_qty
            );
        END IF;
    END LOOP;

    -- FASE 2: Dedução (só executa se toda a fase 1 passou)
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_product_id := v_item->>'id';
        v_qty        := (v_item->>'qty')::numeric;

        UPDATE products
           SET stock      = stock - v_qty,
               updated_at = NOW()
         WHERE id = v_product_id
           AND NOT COALESCE(iscomposed, false);
    END LOOP;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- Permite chamadas anônimas (site público)
GRANT EXECUTE ON FUNCTION deduct_stock_batch(jsonb) TO anon;
GRANT EXECUTE ON FUNCTION deduct_stock_batch(jsonb) TO authenticated;
