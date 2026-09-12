# Alexandria: Matriz de Invariante de Owner, RLS e RPCs (T03A)

**Status:** IMPLEMENTED / FROZEN  
**Data:** 2026-09-11  
**Task:** T03A — Estabelecer owner invariant no banco  
**Issue Relacionada:** #29 (Fundação para #37, #38, #48, #62, #66)  
**Migration:** [`supabase/migrations/20260911010000_establish_owner_invariant.sql`](file:///home/lucca/Projects/alexandria-wt/t03a-owner/supabase/migrations/20260911010000_establish_owner_invariant.sql)  
**Test Suite:** [`tests/integration/test_owner_invariant.py`](file:///home/lucca/Projects/alexandria-wt/t03a-owner/tests/integration/test_owner_invariant.py)

---

## 1. Visão Geral e Princípios Arquiteturais

O objetivo da task **T03A** é eliminar toda possibilidade de dados privados e derivados atravessarem o boundary de isolamento entre owners (`user_id`).

### Princípios Estabelecidos
1. **Fail-Closed por Padrão:** Qualquer registro com `user_id IS NULL` em tabelas privadas é considerado estritamente inacessível para clientes `authenticated` e `anon`.
2. **Sem Bypass Global Implícito:** Foram revogadas cláusulas legadas do tipo `OR user_id IS NULL` que expunham dados órfãos globalmente.
3. **Escopo Estrito em Tabelas Derivadas:** Tabelas como `health_summaries`, `coverage_snapshots`, `entities`, `entity_mentions`, `room_recipes`, `brief_claims` e `sync_log` agora contam com coluna `user_id` e RLS ativo.
4. **Agregações e RPCs Owner-Aware:** Funções como `compute_daily_summary` e buscas semânticas calculam e persistem derivadas estritamente sob o escopo do owner (`v_owner := COALESCE(auth.uid(), p_user_id)`).
5. **Auditoria e Backfill Seguro (Non-Public Fallback):** Linhas legadas não são convertidas em dados públicos. Caso o backfill seja invocado sem target owner aprovado, o procedimento aborta e emite relatório estruturado de auditoria.

---

## 2. Matriz de Tabelas, Principais e Políticas RLS

| Tabela | Coluna de Owner | `anon` | `authenticated` | `service_role` | Cláusula `USING` / `WITH CHECK` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `memories` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `briefs` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `health_entries` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `training_logs` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `projects` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `profile` | `owner_id` (UUID) | SELECT se `owner_id IS NULL` | SELECT se próprio ou NULL; INSERT/UPDATE/DELETE apenas próprio | Bypass explícito | SELECT: `(auth.uid() = owner_id OR owner_id IS NULL)`<br>MUTATIONS: `auth.uid() = owner_id` |
| `health_summaries` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `room_recipes` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `brief_claims` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `entities` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `entity_mentions` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `sync_log` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `coverage_snapshots` | `user_id` (UUID) | Bloqueado por RLS (0 rows) | CRUD próprio | Bypass explícito | `auth.uid() = user_id` |
| `tool_call_log` | `owner_id` (TEXT) | Bloqueado por RLS (0 rows) | SELECT / INSERT próprio | Bypass explícito | `owner_id = (auth.uid())::text` |
| `tool_catalog` | N/A (Catálogo) | SELECT | SELECT | Bypass explícito | N/A (Read-only catalog) |

---

## 3. Catálogo de RPCs e Assinaturas Congeladas

As seguintes assinaturas de funções foram congeladas para compatibilidade contratual estrita com **T03B (Edge Functions Auth / Identity)**, **T05 (Pipeline e Sync Runners)** e **T06 (Identidades Únicas)**:

### 3.1 Agregação e Derivadas
* **`alexandria_priv.compute_daily_summary(target_date DATE, p_user_id UUID DEFAULT NULL, p_timezone TEXT DEFAULT NULL) -> JSONB` (SECURITY INVOKER; JWT callers may only target themselves)**
  - **Modo:** `SECURITY DEFINER`, `SET search_path = public`
  - **Comportamento:** Extrai métricas de `health_entries` e `training_logs` onde `user_id = v_owner`, persistindo o resumo em `health_summaries` com constraint `UNIQUE NULLS NOT DISTINCT (user_id, date)`.

* **`compute_source_coverage(target_days INTEGER DEFAULT 7, p_user_id UUID DEFAULT NULL) -> TABLE(...)`**
  - **Modo:** `SECURITY INVOKER`, `SET search_path = public`
  - **Comportamento:** Avalia cadência de ingestão de logs do owner (`iron-log`, `health-connect`, `daily-summary`).

* **`capture_coverage_snapshot(p_target_days INTEGER DEFAULT 7, p_source_kind TEXT DEFAULT 'health', p_producer TEXT DEFAULT 'scheduler', p_user_id UUID DEFAULT NULL) -> INTEGER`**
  - **Modo:** `SECURITY INVOKER`, `SET search_path = public`
  - **Comportamento:** Persiste snapshot em `coverage_snapshots` associado a `v_owner`.

* **`get_coverage_transition_report(p_days INTEGER DEFAULT 30, p_user_id UUID DEFAULT NULL) -> TABLE(...)`**
  - **Modo:** `SECURITY INVOKER`, `SET search_path = public`
  - **Comportamento:** Analisa transições de cobertura de ingestão isoladas por owner.

### 3.2 Buscas Semânticas (Embeddings)
* **`search_memories(query_embedding vector(1536), match_threshold FLOAT DEFAULT 0.5, match_count INT DEFAULT 10, filter_category TEXT DEFAULT NULL, filter_tags TEXT[] DEFAULT NULL, p_user_id UUID DEFAULT NULL) -> TABLE(...)`**
* **`search_briefs(query_embedding vector(1536), match_threshold FLOAT DEFAULT 0.4, match_count INT DEFAULT 10, filter_kind TEXT DEFAULT NULL, filter_source_job TEXT DEFAULT NULL, filter_date_from DATE DEFAULT NULL, filter_date_to DATE DEFAULT NULL, filter_topics TEXT[] DEFAULT NULL, filter_project_refs TEXT[] DEFAULT NULL, filter_entity_refs TEXT[] DEFAULT NULL, p_user_id UUID DEFAULT NULL) -> TABLE(...)`**
* **`search_health_entries(query_embedding vector(1536), match_threshold FLOAT DEFAULT 0.3, match_count INT DEFAULT 10, filter_entry_type TEXT DEFAULT NULL, p_user_id UUID DEFAULT NULL) -> TABLE(...)`**
* **`search_training_logs(query_embedding vector(1536), match_threshold FLOAT DEFAULT 0.3, match_count INT DEFAULT 10, filter_workout_type TEXT DEFAULT NULL, p_user_id UUID DEFAULT NULL) -> TABLE(...)`**

### 3.3 Mutações Auxiliares
* **`upsert_memory(p_content TEXT, p_title TEXT DEFAULT NULL, p_category TEXT DEFAULT 'note', p_source TEXT DEFAULT 'mcp', p_importance SMALLINT DEFAULT 5, p_tags TEXT[] DEFAULT '{}', p_people TEXT[] DEFAULT '{}', p_metadata JSONB DEFAULT '{}', p_user_id UUID DEFAULT NULL) -> JSONB`**
  - **Comportamento:** Identifica e atualiza memória existente por `(content, user_id)`. Se não existir, insere associando ao `user_id` do caller.

### 3.4 Telemetria
* **`get_tool_activation_report(p_days INTEGER DEFAULT 90, p_owner_id TEXT DEFAULT NULL) -> TABLE(...)`**
  - **Comportamento:** Retorna métricas analíticas de ferramentas filtradas pelo owner.

---

## 4. Auditoria e Estratégia de Backfill para Linhas Legadas

Para migração e atualização de bancos pré-existentes contendo dados sem `user_id` (`NULL`):

### 4.1 Função de Auditoria
* **`alexandria_audit_legacy_unowned_rows() -> JSONB`**
  - **Permissão:** `authenticated`, `service_role`.
  - **Saída:** JSON contendo a contagem exata de linhas `user_id IS NULL` em todas as tabelas privadas.

### 4.2 Função de Backfill (Fail-Closed)
* **`alexandria_backfill_legacy_owner(target_owner_id UUID) -> JSONB`**
  - **Permissão:** Restrita a `service_role` (revogado de `PUBLIC`, `anon`, `authenticated`).
  - **Fail-Closed:**
    - Se `target_owner_id` for `NULL`: **ABORTA** com erro fatal exibindo o relatório de auditoria. Dados órfãos jamais se tornam públicos.
    - Se `target_owner_id` não existir em `auth.users`: **ABORTA** com erro fatal.
    - Se válido: Atualiza atomicamente todas as tabelas privadas mantendo chaves estrangeiras e integridade referencial.

---

## 5. Matriz de Casos de Teste de Integração (Suíte `test_owner_invariant.py`)

1. `test_owner_isolation_memories`: Usuário B não lê, edita nem deleta dados de A; inserção forjada por B com `user_id = A` falha com `42501`.
2. `test_fail_closed_legacy_null_memories`: Linhas históricas sem dono inseridas diretamente ficam invisíveis a A e B.
3. `test_owner_isolation_briefs`: Isolamento completo de briefs markdown.
4. `test_owner_isolation_health_and_training`: Isolamento de `health_entries` e `training_logs`.
5. `test_owner_isolation_projects`: Isolamento de repositórios/projetos.
6. `test_owner_isolation_room_recipes`: Isolamento de receitas de contextualização com `UNIQUE NULLS NOT DISTINCT (user_id, name)`.
7. `test_owner_isolation_brief_claims`: Isolamento de claims do radar de conflitos.
8. `test_owner_isolation_knowledge_graph`: Isolamento de `entities` e `entity_mentions`.
9. `test_owner_isolation_sync_log`: Isolamento de logs de sincronização externa.
10. `test_derived_daily_summary_owner_isolation`: `compute_daily_summary` agrega e armazena derivadas exclusivamente no escopo do caller, sem contaminar outros usuários no mesmo dia.
11. `test_search_memories_owner_isolation`: Busca semântica vetorial restrita ao owner.
12. `test_telemetry_owner_isolation`: Telemetria de ferramentas restrita ao caller.
13. `test_legacy_audit_and_fail_closed_backfill`: Validação do ciclo de auditoria e recusa fail-closed de migração sem owner explícito.
