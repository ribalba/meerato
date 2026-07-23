# Meerato desktop (Electron) build & run helpers.
#
# The app points at the hosted instance via the MEERATO_URL env var (see main.js).
# Override it on the command line if needed, e.g.  make start MEERATO_URL=http://localhost:8000

MEERATO_URL ?= https://meerato.com
export MEERATO_URL

NPM ?= npm

# Where `distinstall` puts things. Defaults to a per-user install (no root
# needed); use PREFIX=/usr/local with sudo for a system-wide one.
PREFIX     ?= $(HOME)/.local
BINDIR     := $(PREFIX)/bin
APPDIR     := $(PREFIX)/share/applications
ICONDIR    := $(PREFIX)/share/icons/hicolor
APP_ID     := meerato
APP_LINK   := $(BINDIR)/$(APP_ID)
DESKTOP    := $(APPDIR)/$(APP_ID).desktop
ICON_SIZES := 16 32 48 64 128 256 512

.PHONY: help install start pack dist clean distinstall distuninstall

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(NPM) install

start: ## Run the app against $(MEERATO_URL)
	$(NPM) start

pack: ## Build an unpacked app into dist/ (no installer)
	$(NPM) run pack

dist: ## Build distributable installers into dist/
	$(NPM) run dist

distinstall: dist ## Build the AppImage and register it with the desktop (KDE/GNOME)
	@set -e; \
	appimage=$$(ls -1t dist/*.AppImage 2>/dev/null | head -n1); \
	if [ -z "$$appimage" ]; then \
		echo "error: no AppImage in dist/ — did the build fail?" >&2; exit 1; \
	fi; \
	appimage=$$(cd "$$(dirname "$$appimage")" && pwd)/$$(basename "$$appimage"); \
	chmod +x "$$appimage"; \
	mkdir -p "$(BINDIR)" "$(APPDIR)"; \
	ln -sfn "$$appimage" "$(APP_LINK)"; \
	echo "  bin     $(APP_LINK) -> $$appimage"; \
	for s in $(ICON_SIZES); do \
		icon="build/icons/$${s}x$${s}.png"; \
		[ -f "$$icon" ] || continue; \
		mkdir -p "$(ICONDIR)/$${s}x$${s}/apps"; \
		cp -f "$$icon" "$(ICONDIR)/$${s}x$${s}/apps/$(APP_ID).png"; \
	done; \
	echo "  icons   $(ICONDIR)/*/apps/$(APP_ID).png"; \
	{ \
		echo "[Desktop Entry]"; \
		echo "Type=Application"; \
		echo "Version=1.0"; \
		echo "Name=Meerato"; \
		echo "GenericName=To-do"; \
		echo "Comment=Desktop wrapper for the Meerato to-do app."; \
		echo "Exec=env MEERATO_URL=$(MEERATO_URL) $(APP_LINK) %u"; \
		echo "TryExec=$(APP_LINK)"; \
		echo "Icon=$(APP_ID)"; \
		echo "Terminal=false"; \
		echo "Categories=Office;ProjectManagement;"; \
		echo "Keywords=todo;tasks;meerato;"; \
		echo "StartupNotify=true"; \
		echo "StartupWMClass=meerato"; \
		echo "MimeType=x-scheme-handler/meerato;"; \
	} > "$(DESKTOP)"; \
	chmod 644 "$(DESKTOP)"; \
	echo "  desktop $(DESKTOP)"; \
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(APPDIR)" || true; \
	command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -f -t "$(ICONDIR)" || true; \
	command -v xdg-mime >/dev/null 2>&1 && xdg-mime default "$(APP_ID).desktop" x-scheme-handler/meerato || true; \
	for kb in kbuildsycoca6 kbuildsycoca5; do \
		command -v $$kb >/dev/null 2>&1 && $$kb --noincremental >/dev/null 2>&1 && break; \
	done; true; \
	case ":$$PATH:" in *":$(BINDIR):"*) ;; \
		*) echo "  note: $(BINDIR) is not on your PATH — the menu entry still works";; \
	esac; \
	echo "Installed. It should show up in the KDE/GNOME launcher (log out and back in if not)."

distuninstall: ## Remove the desktop entry, icons and launcher symlink
	@rm -f "$(DESKTOP)" "$(APP_LINK)"
	@for s in $(ICON_SIZES); do rm -f "$(ICONDIR)/$${s}x$${s}/apps/$(APP_ID).png"; done
	@command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(APPDIR)" || true
	@command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -f -t "$(ICONDIR)" || true
	@echo "Removed desktop integration (dist/ left untouched — 'make clean' for that)."

clean: ## Remove build output
	rm -rf dist
