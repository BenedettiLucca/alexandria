# Baseline Lint & Formatting Report (Harness T01)

Este documento registra os pinos de dependência e o estado de referência (baseline) de linting e formatação do repositório no momento da entrega do harness T01 (`sprint-stabilization-1`).

Conforme o protocolo do sprint e as regras do repositório (`AGENTS.md`), alterações de formatação ou correção de regras de linter em arquivos legados/fora do escopo estrito **não devem ser realizadas** (anti-scope: *não formatar o repo inteiro; não tocar em `supabase/functions/**`*).

---

## 1. Pinos de Ambiente e Dependências

A instalação é reprodutível localmente e alinhada com os workflows de CI.

| Ferramenta / Pacote | Versão Pinada / Auditada | Finalidade |
|---|---|---|
| **Supabase CLI** | `2.117.0` | CLI canônica para orquestração da stack local (12 containers) |
| **PostgreSQL** (Docker) | `17.6.1` (`public.ecr.aws/supabase/postgres:17.6.1.167`) | Engine relacional e pgvector |
| **PostgREST** (Docker) | `14.5` (`public.ecr.aws/supabase/postgrest:v14.5`) | Gateway REST/RPC na porta 54321 |
| **Python** | `3.11.15` | Runtime dos importers e suite de testes de integração |
| **Deno** | `2.9.6` (`typescript 6.0.3`) | Runtime do Alexandria Edge Functions |
| **Docker Engine** | `29.7.2` | Runtime dos containers Supabase |
| **supabase-py** | `2.31.0` | Cliente Python oficial do Supabase |
| **postgrest-py** | `2.31.0` | Cliente REST/RPC Python |
| **asyncpg** | `0.31.0` | Driver PostgreSQL assíncrono para inspeção de schema/pg_proc |
| **pytest** | `9.1.1` | Test runner dos importers e integration tests |
| **ruff** | `0.16.6` | Linter e formatter Python de alta performance |

---

## 2. Baseline de Linting e Formatação Python

### 2.1. Formatação (`ruff format --check .`)
- **Arquivos formatados e limpos**: 100% da nova suíte `tests/integration/` foi formatada e está em total conformidade.
- **Arquivos pré-existentes não formatados**: 6 arquivos em `importers/` apresentam desvios de formatação em relação às regras padrão do Ruff:
  - `importers/test_import_health_connect.py`
  - `importers/test_import_ironlog.py`
  - `importers/test_shared.py`
  - `importers/test_sync.py`
  - `importers/health_connect/import_health_connect.py`
  - `importers/sync.py`

### 2.2. Linter Python (`ruff check .`)
Total de problemas detectados no baseline legado: **62 erros** em `importers/`.

Detalhamento por regra:
- `RUF059` (Unpacked variable never used): 12 ocorrências (variável `skipped` desempacotada sem uso).
- `I001` (Import block un-sorted / un-formatted): 20 ocorrências em múltiplos arquivos de teste.
- `F401` (Unused imports): 10 ocorrências (ex.: `tempfile`, `unittest.mock.MagicMock`).
- `S110` / `BLE001` (Blind try-except-pass): 4 ocorrências (ex.: `test_import_ironlog.py:631`).
- `RUF015` (Prefer `next(...)` over slice): 2 ocorrências.

*Nota: Todos os arquivos sob `tests/integration/` passam com zero erros no `ruff check`.*

---

## 3. Baseline de Linting e Formatação Deno (`supabase/functions/alexandria`)

### 3.1. Formatação (`deno fmt --check`)
- Total de arquivos verificados: 30
- Total de arquivos fora do formato canônico do Deno: **9 arquivos**:
  - `deno.json`
  - `tools/memories.test.ts`
  - `tools/recipes.test.ts`
  - `tools/room_manifest.test.ts`
  - `tools/health.test.ts`
  - `tools/coverage_transitions.test.ts`
  - `lib.test.ts`
  - `tools/briefs.test.ts`
  - `tools/conflict_radar.test.ts`

### 3.2. Linter Deno (`deno lint`)
Total de problemas detectados no baseline legado: **43 problemas** em 29 arquivos.

Detalhamento por regra:
- `no-import-prefix`: 22 ocorrências (uso inline de specifiers `npm:`, `jsr:` ou `https:` em vez de aliases no `deno.json`).
- `no-explicit-any`: 11 ocorrências em suites de teste (`tools/recipes.test.ts`, `tools/health.test.ts`).
- `no-unused-vars`: 5 ocorrências (ex.: `BriefClaim`, `assertExists`, `CoverageRow`, `staleCount`).
- `require-await`: 5 ocorrências (funções assíncronas declaradas com `async` sem expressão `await`).

---

## 4. Isolamento e Salvaguarda

Nenhum arquivo de produção fora da allowlist foi modificado para mitigar o baseline acima, preservando a integridade dos contratos e evitando conflitos com lanes paralelas que trabalham em `supabase/functions/alexandria`.
