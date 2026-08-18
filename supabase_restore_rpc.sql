-- =====================================================================
-- ESTOQUE CENTRALIZADO — Função RPC de devolução
-- Execute este SQL no painel do Supabase (SQL Editor)
-- =====================================================================

CREATE OR REPLACE FUNCTION restore_stock_batch(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_item        jsonb;
    v_product_id  text;
    v_qty         numeric;
BEGIN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_product_id := v_item->>'id';
        v_qty        := (v_item->>'qty')::numeric;

        UPDATE products
           SET stock      = stock + v_qty,
               updated_at = NOW()
         WHERE id = v_product_id
           AND NOT COALESCE(iscomposed, false);
    END LOOP;

    RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION restore_stock_batch(jsonb) TO anon;
GRANT EXECUTE ON FUNCTION restore_stock_batch(jsonb) TO authenticated;
