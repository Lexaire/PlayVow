.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

.PHONY: help provision deploy deploy-check

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "; printf "Targets:\n"} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

provision: ## Run the full Ansible site playbook against the inventory host
	cd ansible && ansible-playbook playbooks/site.yml

deploy: ## Build, ship, and restart playvow-web + playvow-worker on the VPS
	./deploy.sh

deploy-check: ## Run deploy preflight only (no build, no ship)
	./deploy.sh --check
