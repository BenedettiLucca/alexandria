-- Migration: 20260911080000_switch_embedding_space_qwen3_2048.sql
-- Task: D-EMBED — switch embedding space p/ qwen/qwen3-embedding-8b @ 2048
-- Estratégia: cirúrgica. Colunas via ALTER; funções via patch do def ATUAL
-- (pg_get_functiondef), alterando apenas:
--   1. param query_embedding vector -> vector(2048)
--   2. default/literal 'openai/text-embedding-3-small' -> 'qwen/qwen3-embedding-8b'
--   3. DEFAULT 1536 (target_dimension do lifecycle T05B) -> DEFAULT 2048
-- Corpos, filtros, owner-scoping e space guards permanecem intatos.
-- Banco local vazio (hosted nuked): sem reindex de legado. Idempotente.
-- NOTA: pgvector 0.8.0 limita HNSW a 2000 dims p/ vector. Como o perfil é
-- single-user (corpus pequeno, precisão > latência), os 4 índices HNSW dos
-- embeddings viram EXACT scan (sequencial), sem índice ANN. Para corpus
-- grande no futuro: pgvector>=0.10 + halfvec(2048) hnsw (revisitar).
DROP INDEX IF EXISTS public.idx_memories_embedding;
DROP INDEX IF EXISTS public.idx_briefs_embedding;
DROP INDEX IF EXISTS public.idx_health_entries_embedding;
DROP INDEX IF EXISTS public.idx_training_logs_embedding;

-- Default da COLUNA embedding_space (entra antes do trigger; COALESCE respeita)
ALTER TABLE public.memories ALTER COLUMN embedding_space SET DEFAULT 'qwen/qwen3-embedding-8b';
ALTER TABLE public.briefs ALTER COLUMN embedding_space SET DEFAULT 'qwen/qwen3-embedding-8b';
ALTER TABLE public.health_entries ALTER COLUMN embedding_space SET DEFAULT 'qwen/qwen3-embedding-8b';
ALTER TABLE public.training_logs ALTER COLUMN embedding_space SET DEFAULT 'qwen/qwen3-embedding-8b';

ALTER TABLE public.memories
  ALTER COLUMN embedding TYPE vector(2048) USING (embedding::text)::vector;
ALTER TABLE public.briefs
  ALTER COLUMN embedding TYPE vector(2048) USING (embedding::text)::vector;
ALTER TABLE public.health_entries
  ALTER COLUMN embedding TYPE vector(2048) USING (embedding::text)::vector;
ALTER TABLE public.training_logs
  ALTER COLUMN embedding TYPE vector(2048) USING (embedding::text)::vector;

DO $patch$
DECLARE
  r record;
  def text;
  newdef text;
  touched integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ~ 'query_embedding vector|openai/text-embedding-3-small|target_dimension'
  LOOP
    def := pg_get_functiondef(r.oid);
    newdef := replace(
      replace(
        replace(
          def,
          'query_embedding vector,',
          'query_embedding vector(2048),'
        ),
        'openai/text-embedding-3-small',
        'qwen/qwen3-embedding-8b'
      ),
      'DEFAULT 1536',
      'DEFAULT 2048'
    );
    IF newdef <> def THEN
      EXECUTE newdef;
      touched := touched + 1;
      RAISE NOTICE 'patched function %', r.oid::regprocedure;
    END IF;
  END LOOP;
  RAISE NOTICE 'functions patched: %', touched;
END
$patch$;
