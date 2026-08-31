.DEFAULT_GOAL := help

PYTHON ?= .venv/bin/python
HOST ?= 127.0.0.1
PORT ?= 8080

.PHONY: help run test lint deploy deploy-rotate-code smoke

help:
	@printf '%s\n' \
		'make run              Start local FotoVibe (frees PORT first)' \
		'make run PORT=8081    Start on another port' \
		'make test             Run the test suite' \
		'make lint             Run Ruff' \
		'make deploy           Provision and deploy to Google Cloud' \
		'make deploy-rotate-code  Rotate party code and deploy' \
		'make smoke            Test the deployed custom domain'

run:
	@if [ ! -x "$(PYTHON)" ]; then \
		echo "Python executable not found: $(PYTHON). Run the setup commands in README.md first." >&2; \
		exit 1; \
	fi
	@FOTOVIBE_DEV=1 "$(PYTHON)" scripts/dev.py --host "$(HOST)" --port "$(PORT)"

test:
	@env -u UV_DEFAULT_INDEX "$(PYTHON)" -m pytest -q

lint:
	@env -u UV_DEFAULT_INDEX "$(PYTHON)" -m ruff check fotovibe tests scripts

deploy:
	@python3 scripts/deploy.py

deploy-rotate-code:
	@python3 scripts/deploy.py --rotate-code

smoke:
	@"$(PYTHON)" scripts/smoke.py
