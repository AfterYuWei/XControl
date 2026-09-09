.PHONY: dev web-dev

dev:
	npm run desktop:dev

web-dev:
	npm --prefix web run dev
