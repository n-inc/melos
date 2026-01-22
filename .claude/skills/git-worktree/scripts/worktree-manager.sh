#!/bin/bash

# Git Worktree Manager
# Handles creating, listing, switching, and cleaning up Git worktrees
# KISS principle: Simple, interactive, opinionated

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get repo root
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_DIR="$GIT_ROOT/.worktrees"

# Skip prompts flag (set by --yes / -y option)
SKIP_PROMPTS=false

# Files to copy from main repo to worktree (gitignored but needed for development)
COPY_FILES=(".env" "api/.env" "api/config/service_account_key.json" "frontend/service_account_key.json")
# Directories to copy from main repo to worktree
COPY_DIRS=(".claude/plans")

# Securely delete credential files from worktree before cleanup
secure_delete_credentials() {
  local target_path="$1"

  echo -e "${BLUE}  Removing credential files...${NC}"
  for file in "${COPY_FILES[@]}"; do
    if [[ -f "$target_path/$file" ]]; then
      rm -f "$target_path/$file"
      echo -e "${GREEN}    ✓ Removed $file${NC}"
    fi
  done
}

# Copy important gitignored files and directories to worktree
copy_gitignored_files() {
  local target_path="$1"

  for file in "${COPY_FILES[@]}"; do
    if [[ -f "$GIT_ROOT/$file" ]]; then
      local target_dir=$(dirname "$target_path/$file")
      mkdir -p "$target_dir"
      cp "$GIT_ROOT/$file" "$target_path/$file"
      echo -e "${GREEN}  ✓ Copied $file${NC}"
    fi
  done

  for dir in "${COPY_DIRS[@]}"; do
    if [[ -d "$GIT_ROOT/$dir" ]]; then
      # Create parent directory and remove existing target to avoid nesting
      local target_parent=$(dirname "$target_path/$dir")
      mkdir -p "$target_parent"
      rm -rf "$target_path/$dir"
      cp -r "$GIT_ROOT/$dir" "$target_path/$dir"
      echo -e "${GREEN}  ✓ Copied $dir/${NC}"
    fi
  done
}

# Setup mise in worktree directory
setup_mise() {
  local target_path="$1"

  if ! command -v mise &> /dev/null; then
    echo -e "${YELLOW}  ⚠ mise not found, skipping mise setup${NC}"
    return
  fi

  # Trust mise in project root (supports both mise.toml and .mise.toml)
  if [[ -f "$target_path/mise.toml" || -f "$target_path/.mise.toml" ]]; then
    (cd "$target_path" && mise trust) 2>/dev/null
    echo -e "${GREEN}  ✓ mise trust (root)${NC}"
  fi
}

# Ensure .worktrees is in .gitignore
ensure_gitignore() {
  if ! grep -q "^\.worktrees$" "$GIT_ROOT/.gitignore" 2>/dev/null; then
    echo ".worktrees" >> "$GIT_ROOT/.gitignore"
  fi
}

# Create a new worktree
create_worktree() {
  local branch_name="$1"
  local from_branch="${2:-main}"

  if [[ -z "$branch_name" ]]; then
    echo -e "${RED}Error: Branch name required${NC}"
    exit 1
  fi

  local worktree_path="$WORKTREE_DIR/$branch_name"

  # Check if worktree already exists
  if [[ -d "$worktree_path" ]]; then
    echo -e "${YELLOW}Worktree already exists at: $worktree_path${NC}"
    if [[ "$SKIP_PROMPTS" == "true" ]]; then
      echo -e "${BLUE}--yes specified: switching to existing worktree${NC}"
      switch_worktree "$branch_name"
    else
      echo -e "Switch to it instead? (y/n)"
      echo -e "${BLUE}Tip: Use --yes to skip this prompt${NC}"
      read -r response
      if [[ "$response" == "y" ]]; then
        switch_worktree "$branch_name"
      fi
    fi
    return
  fi

  echo -e "${BLUE}Creating worktree: $branch_name${NC}"
  echo "  From: $from_branch"
  echo "  Path: $worktree_path"
  echo ""

  if [[ "$SKIP_PROMPTS" == "true" ]]; then
    echo -e "${BLUE}--yes specified: proceeding with creation${NC}"
  else
    echo "Proceed? (y/n)"
    echo -e "${BLUE}Tip: Use --yes to skip this prompt${NC}"
    read -r response

    if [[ "$response" != "y" ]]; then
      echo -e "${YELLOW}Cancelled${NC}"
      return
    fi
  fi

  # Update main branch
  echo -e "${BLUE}Updating $from_branch...${NC}"
  git checkout "$from_branch"
  git pull origin "$from_branch" || true

  # Create worktree
  mkdir -p "$WORKTREE_DIR"
  ensure_gitignore

  echo -e "${BLUE}Creating worktree...${NC}"
  git worktree add -b "$branch_name" "$worktree_path" "$from_branch"

  # Copy important gitignored files to worktree
  echo -e "${BLUE}Copying environment files...${NC}"
  copy_gitignored_files "$worktree_path"

  # Setup mise
  echo -e "${BLUE}Setting up mise...${NC}"
  setup_mise "$worktree_path"

  echo -e "${GREEN}✓ Worktree created successfully!${NC}"
  echo ""
  echo "To switch to this worktree:"
  echo -e "${BLUE}cd $worktree_path${NC}"
  echo ""
}

# List all worktrees
list_worktrees() {
  echo -e "${BLUE}Available worktrees:${NC}"
  echo ""

  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo -e "${YELLOW}No worktrees found${NC}"
    return
  fi

  local count=0
  for worktree_path in "$WORKTREE_DIR"/*; do
    if [[ -d "$worktree_path" && -e "$worktree_path/.git" ]]; then
      count=$((count + 1))
      local worktree_name=$(basename "$worktree_path")
      local branch=$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

      if [[ "$PWD" == "$worktree_path" ]]; then
        echo -e "${GREEN}✓ $worktree_name${NC} (current) → branch: $branch"
      else
        echo -e "  $worktree_name → branch: $branch"
      fi
    fi
  done

  if [[ $count -eq 0 ]]; then
    echo -e "${YELLOW}No worktrees found${NC}"
  else
    echo ""
    echo -e "${BLUE}Total: $count worktree(s)${NC}"
  fi

  echo ""
  echo -e "${BLUE}Main repository:${NC}"
  local main_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  echo "  Branch: $main_branch"
  echo "  Path: $GIT_ROOT"
}

# Switch to a worktree
switch_worktree() {
  local worktree_name="$1"

  if [[ -z "$worktree_name" ]]; then
    if [[ "$SKIP_PROMPTS" == "true" ]]; then
      echo -e "${RED}Error: --yes requires worktree name argument${NC}"
      echo ""
      list_worktrees
      exit 1
    fi
    list_worktrees
    echo -e "${BLUE}Switch to which worktree? (enter name)${NC}"
    echo -e "${BLUE}Tip: Use 'switch <name>' to skip this prompt${NC}"
    read -r worktree_name
  fi

  local worktree_path="$WORKTREE_DIR/$worktree_name"

  if [[ ! -d "$worktree_path" ]]; then
    echo -e "${RED}Error: Worktree not found: $worktree_name${NC}"
    echo ""
    list_worktrees
    exit 1
  fi

  echo -e "${GREEN}Switching to worktree: $worktree_name${NC}"
  cd "$worktree_path"
  echo -e "${BLUE}Now in: $(pwd)${NC}"
}

# Clean up completed worktrees
cleanup_worktrees() {
  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo -e "${YELLOW}No worktrees to clean up${NC}"
    return
  fi

  echo -e "${BLUE}Checking for completed worktrees...${NC}"
  echo ""

  local found=0
  local to_remove=()

  for worktree_path in "$WORKTREE_DIR"/*; do
    if [[ -d "$worktree_path" && -e "$worktree_path/.git" ]]; then
      local worktree_name=$(basename "$worktree_path")

      # Skip if current worktree
      if [[ "$PWD" == "$worktree_path" ]]; then
        echo -e "${YELLOW}(skip) $worktree_name - currently active${NC}"
        continue
      fi

      found=$((found + 1))
      to_remove+=("$worktree_path")
      echo -e "${YELLOW}• $worktree_name${NC}"
    fi
  done

  if [[ $found -eq 0 ]]; then
    echo -e "${GREEN}No inactive worktrees to clean up${NC}"
    return
  fi

  echo ""
  if [[ "$SKIP_PROMPTS" == "true" ]]; then
    echo -e "${BLUE}--yes specified: removing all inactive worktrees${NC}"
  else
    echo -e "Remove $found worktree(s)? (y/n)"
    echo -e "${BLUE}Tip: Use --yes to skip this prompt${NC}"
    read -r response

    if [[ "$response" != "y" ]]; then
      echo -e "${YELLOW}Cleanup cancelled${NC}"
      return
    fi
  fi

  echo -e "${BLUE}Cleaning up worktrees...${NC}"
  for worktree_path in "${to_remove[@]}"; do
    local worktree_name=$(basename "$worktree_path")
    # Securely delete credential files before removing worktree
    secure_delete_credentials "$worktree_path"
    git worktree remove "$worktree_path" --force 2>/dev/null || true
    echo -e "${GREEN}✓ Removed: $worktree_name${NC}"
  done

  # Clean up empty directory if nothing left
  if [[ -z "$(ls -A "$WORKTREE_DIR" 2>/dev/null)" ]]; then
    rmdir "$WORKTREE_DIR" 2>/dev/null || true
  fi

  echo -e "${GREEN}Cleanup complete!${NC}"
}

# Main command handler
main() {
  # Parse global options first
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes|-y)
        SKIP_PROMPTS=true
        shift
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  local command="${args[0]:-list}"

  case "$command" in
    create)
      create_worktree "${args[1]}" "${args[2]}"
      ;;
    list|ls)
      list_worktrees
      ;;
    switch|go)
      switch_worktree "${args[1]}"
      ;;
    cleanup|clean)
      cleanup_worktrees
      ;;
    help)
      show_help
      ;;
    *)
      echo -e "${RED}Unknown command: $command${NC}"
      echo ""
      show_help
      exit 1
      ;;
  esac
}

show_help() {
  cat << EOF
Git Worktree Manager

Usage: worktree-manager.sh [options] <command> [command-options]

Options:
  --yes, -y                           Skip all confirmation prompts

Commands:
  create <branch-name> [from-branch]  Create new worktree
                                      (from-branch defaults to main)
  list | ls                           List all worktrees
  switch | go [name]                  Switch to worktree
  cleanup | clean                     Clean up inactive worktrees
  help                                Show this help message

Examples:
  worktree-manager.sh create feature-login
  worktree-manager.sh switch feature-login
  worktree-manager.sh cleanup
  worktree-manager.sh list
  worktree-manager.sh --yes create feature-login
  worktree-manager.sh -y cleanup

EOF
}

# Run
main "$@"
