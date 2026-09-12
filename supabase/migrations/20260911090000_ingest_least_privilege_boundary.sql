-- ==============================================================================
-- Alexandria Migration: 20260911090000_ingest_least_privilege_boundary.sql
-- Task: T20A — Boundary least-privilege para importers (#29, #33, #37, #66)
--
-- Scope:
-- 1. Cria tabela ingest_credentials com hash seguro (SHA256), escopo por domínio e status ativo/revogado.
-- 2. RLS estrito: anon bloqueado (0 rows), authenticated apenas próprias credenciais, service_role bypass.
-- 3. RPCs de gestão de credenciais: create, rotate, revoke e authenticate_ingest_credential.
-- 4. Validação de domínios permitidos: 'health', 'training', 'brief', 'sync'.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABELA DE REGISTRO DE CREDENCIAIS DE INGEST (ingest_credentials)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    domain_scopes TEXT[] NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ DEFAULT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ingest_credentials_domains_check CHECK (
        domain_scopes <@ ARRAY['health', 'training', 'brief', 'sync']::TEXT[]
        AND array_length(domain_scopes, 1) > 0
    )
);

CREATE INDEX IF NOT EXISTS idx_ingest_credentials_user_id ON ingest_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_ingest_credentials_key_hash ON ingest_credentials(key_hash);
CREATE INDEX IF NOT EXISTS idx_ingest_credentials_status ON ingest_credentials(status);

-- ------------------------------------------------------------------------------
-- 2. HABILITACAO DE RLS E POLITICAS FAIL-CLOSED
-- ------------------------------------------------------------------------------

ALTER TABLE ingest_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_ingest_credentials" ON ingest_credentials;
DROP POLICY IF EXISTS "users_insert_own_ingest_credentials" ON ingest_credentials;
DROP POLICY IF EXISTS "users_update_own_ingest_credentials" ON ingest_credentials;
DROP POLICY IF EXISTS "users_delete_own_ingest_credentials" ON ingest_credentials;

CREATE POLICY "users_read_own_ingest_credentials"
    ON ingest_credentials FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_ingest_credentials"
    ON ingest_credentials FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_ingest_credentials"
    ON ingest_credentials FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_ingest_credentials"
    ON ingest_credentials FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 3. RPCS ATOMICAS DE AUTENTICACAO, ROTACAO E GESTAO
-- ------------------------------------------------------------------------------

-- 3.1 Autenticacao de credencial
CREATE OR REPLACE FUNCTION authenticate_ingest_credential(
    p_key_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cred RECORD;
BEGIN
    IF p_key_hash IS NULL OR trim(p_key_hash) = '' THEN
        RETURN jsonb_build_object('authenticated', false, 'reason', 'missing_key');
    END IF;

    SELECT id, user_id, name, domain_scopes, key_prefix, status
    INTO v_cred
    FROM ingest_credentials
    WHERE key_hash = p_key_hash;

    IF v_cred.id IS NULL THEN
        RETURN jsonb_build_object('authenticated', false, 'reason', 'invalid_key');
    END IF;

    IF v_cred.status <> 'active' THEN
        RETURN jsonb_build_object('authenticated', false, 'reason', 'revoked_key');
    END IF;

    -- Atualiza timestamp de ultimo uso
    UPDATE ingest_credentials
    SET last_used_at = now()
    WHERE id = v_cred.id;

    RETURN jsonb_build_object(
        'authenticated', true,
        'credential_id', v_cred.id,
        'user_id', v_cred.user_id,
        'name', v_cred.name,
        'key_prefix', v_cred.key_prefix,
        'domain_scopes', v_cred.domain_scopes
    );
END;
$$;

-- 3.2 Criacao de credencial
CREATE OR REPLACE FUNCTION create_ingest_credential(
    p_user_id UUID,
    p_name TEXT,
    p_key_hash TEXT,
    p_key_prefix TEXT,
    p_domain_scopes TEXT[],
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_id UUID;
    v_scopes TEXT[];
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: create_ingest_credential requires authenticated owner or explicit user_id';
    END IF;

    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Credential name cannot be empty';
    END IF;

    IF p_key_hash IS NULL OR trim(p_key_hash) = '' THEN
        RAISE EXCEPTION 'Key hash cannot be empty';
    END IF;

    v_scopes := ARRAY(
        SELECT DISTINCT x
        FROM unnest(COALESCE(p_domain_scopes, '{}'::text[])) AS t(x)
        WHERE x IS NOT NULL AND trim(x) <> ''
        ORDER BY 1
    );

    IF array_length(v_scopes, 1) IS NULL OR NOT (v_scopes <@ ARRAY['health', 'training', 'brief', 'sync']::TEXT[]) THEN
        RAISE EXCEPTION 'Invalid domain scopes: must only contain health, training, brief, sync';
    END IF;

    INSERT INTO ingest_credentials (
        user_id, name, key_hash, key_prefix, domain_scopes, status, metadata, created_at
    ) VALUES (
        v_owner, trim(p_name), p_key_hash, p_key_prefix, v_scopes, 'active', COALESCE(p_metadata, '{}'::jsonb), now()
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'id', v_id,
        'user_id', v_owner,
        'name', trim(p_name),
        'key_prefix', p_key_prefix,
        'domain_scopes', v_scopes,
        'status', 'active'
    );
END;
$$;

-- 3.3 Rotacao atomica de credencial (revoga anterior e cria nova)
CREATE OR REPLACE FUNCTION rotate_ingest_credential(
    p_old_key_hash TEXT,
    p_new_key_hash TEXT,
    p_new_key_prefix TEXT,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_old_cred RECORD;
    v_new_id UUID;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);

    IF p_old_key_hash IS NULL OR p_new_key_hash IS NULL THEN
        RAISE EXCEPTION 'Both old and new key hashes are required for rotation';
    END IF;

    -- Localiza credencial antiga
    SELECT * INTO v_old_cred
    FROM ingest_credentials
    WHERE key_hash = p_old_key_hash
    FOR UPDATE;

    IF v_old_cred.id IS NULL THEN
        RAISE EXCEPTION 'Old credential not found';
    END IF;

    IF v_owner IS NOT NULL AND v_old_cred.user_id <> v_owner THEN
        RAISE EXCEPTION 'Owner mismatch: cannot rotate credential belonging to another owner';
    END IF;

    IF v_old_cred.status <> 'active' THEN
        RAISE EXCEPTION 'Cannot rotate inactive or already revoked credential';
    END IF;

    -- 1. Revoga credencial antiga
    UPDATE ingest_credentials
    SET status = 'revoked',
        revoked_at = now()
    WHERE id = v_old_cred.id;

    -- 2. Insere nova credencial com os mesmos escopos e metadados
    INSERT INTO ingest_credentials (
        user_id, name, key_hash, key_prefix, domain_scopes, status, metadata, created_at
    ) VALUES (
        v_old_cred.user_id, v_old_cred.name, p_new_key_hash, p_new_key_prefix,
        v_old_cred.domain_scopes, 'active', v_old_cred.metadata, now()
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'status', 'rotated',
        'revoked_credential_id', v_old_cred.id,
        'new_credential_id', v_new_id,
        'name', v_old_cred.name,
        'key_prefix', p_new_key_prefix,
        'domain_scopes', v_old_cred.domain_scopes
    );
END;
$$;

-- 3.4 Revogacao explicita de credencial
CREATE OR REPLACE FUNCTION revoke_ingest_credential(
    p_key_hash TEXT,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_cred RECORD;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);

    SELECT * INTO v_cred
    FROM ingest_credentials
    WHERE key_hash = p_key_hash
    FOR UPDATE;

    IF v_cred.id IS NULL THEN
        RETURN jsonb_build_object('revoked', false, 'reason', 'not_found');
    END IF;

    IF v_owner IS NOT NULL AND v_cred.user_id <> v_owner THEN
        RAISE EXCEPTION 'Owner mismatch: cannot revoke credential belonging to another owner';
    END IF;

    UPDATE ingest_credentials
    SET status = 'revoked',
        revoked_at = now()
    WHERE id = v_cred.id;

    RETURN jsonb_build_object('revoked', true, 'credential_id', v_cred.id);
END;
$$;

-- Hardening: EXECUTE para PUBLIC e o default do Postgres; REVOKE explicito obrigatorio
REVOKE EXECUTE ON FUNCTION authenticate_ingest_credential(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION create_ingest_credential(UUID,TEXT,TEXT,TEXT,TEXT[],JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION rotate_ingest_credential(TEXT,TEXT,TEXT,UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION revoke_ingest_credential(TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION authenticate_ingest_credential TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION create_ingest_credential TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION rotate_ingest_credential TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION revoke_ingest_credential TO authenticated, service_role;
