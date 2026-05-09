.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

.PHONY: help prod-db-migrate prod-db-seed prod-db-smoke prod-scrape-once \
        prod-poll-once prod-scrape-steam-members prod-smoke-verify \
        scrape-once poll-once scrape-steam-members smoke-verify

# Production targets load TWO env files: infra/.env.production (uploaded
# byte-identical to the server) plus infra/.env.cli-prod (gitignored CLI
# overlay holding DB_MODE=remote and LOCAL_DB_PATH=file:local-prod.db).
# Both are needed because .env.production deliberately omits those keys so
# its uploaded copy doesn't override the server's per-service systemd
# Environment= directives.
#
# Ad-hoc one-shots (scrape/poll/smoke) accept ENV_FILE=<path> to point at
# any single complete env file (e.g. a staging one). Use the prod-* targets
# when you want to hit production.
PROD_ENV_ARGS := --env-file=infra/.env.production --env-file=infra/.env.cli-prod
ENV_FILE ?=
BUN_ENV_ARGS := $(if $(ENV_FILE),--env-file=$(ENV_FILE),)

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "; printf "Targets:\n"} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

prod-db-migrate: ## Apply pending migrations against the production DB
	bun $(PROD_ENV_ARGS) run src/db/migrate.ts

prod-db-seed: ## Seed the taleplay group into the production DB
	bun $(PROD_ENV_ARGS) run src/db/seed.ts

prod-db-smoke: ## Print row counts from the production DB
	bun $(PROD_ENV_ARGS) run src/db/smoke.ts

prod-scrape-once: ## Scrape against prod (SLUG=<slug> to scope to one group)
	bun $(PROD_ENV_ARGS) run src/scripts/scrape-once.ts $(SLUG)

prod-poll-once: ## Playtime poll against prod
	bun $(PROD_ENV_ARGS) run src/scripts/poll-once.ts

prod-scrape-steam-members: ## Steam group members scrape against prod
	bun $(PROD_ENV_ARGS) run src/scripts/scrape-steam-members.ts

prod-smoke-verify: ## Read-only DB summary against prod
	bun $(PROD_ENV_ARGS) run src/scripts/smoke-verify.ts

scrape-once: ## One-shot scrape (SLUG=<slug> to scope, ENV_FILE=path for non-prod env)
	bun $(BUN_ENV_ARGS) run src/scripts/scrape-once.ts $(SLUG)

poll-once: ## One-shot playtime poll (ENV_FILE=path for non-prod env)
	bun $(BUN_ENV_ARGS) run src/scripts/poll-once.ts

scrape-steam-members: ## One-shot Steam group members scrape (ENV_FILE=path for non-prod env)
	bun $(BUN_ENV_ARGS) run src/scripts/scrape-steam-members.ts

smoke-verify: ## Read-only DB summary (ENV_FILE=path for non-prod env)
	bun $(BUN_ENV_ARGS) run src/scripts/smoke-verify.ts

deploy: ## Deploy the application
	bash infra/deploy.sh
