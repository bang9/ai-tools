CLI_BINARY = memex
MCP_BINARY = memex-mcp
DIST_DIR = dist
BIN_DIR = bin

PLATFORMS = darwin-arm64 darwin-amd64 linux-amd64 windows-amd64

.PHONY: build build-cli build-mcp cross test clean

build: build-cli build-mcp

build-cli:
	go build -o $(CLI_BINARY) ./cmd/memex

build-mcp:
	mkdir -p $(BIN_DIR)
	go build -o $(BIN_DIR)/$(MCP_BINARY) ./cmd/memex-mcp

cross:
	mkdir -p $(DIST_DIR)
	GOOS=darwin GOARCH=arm64 go build -o $(DIST_DIR)/$(CLI_BINARY)-darwin-arm64 ./cmd/memex
	GOOS=darwin GOARCH=amd64 go build -o $(DIST_DIR)/$(CLI_BINARY)-darwin-amd64 ./cmd/memex
	GOOS=linux GOARCH=amd64 go build -o $(DIST_DIR)/$(CLI_BINARY)-linux-amd64 ./cmd/memex
	GOOS=windows GOARCH=amd64 go build -o $(DIST_DIR)/$(CLI_BINARY)-windows-amd64.exe ./cmd/memex
	GOOS=darwin GOARCH=arm64 go build -o $(DIST_DIR)/$(MCP_BINARY)-darwin-arm64 ./cmd/memex-mcp
	GOOS=darwin GOARCH=amd64 go build -o $(DIST_DIR)/$(MCP_BINARY)-darwin-amd64 ./cmd/memex-mcp
	GOOS=linux GOARCH=amd64 go build -o $(DIST_DIR)/$(MCP_BINARY)-linux-amd64 ./cmd/memex-mcp
	GOOS=windows GOARCH=amd64 go build -o $(DIST_DIR)/$(MCP_BINARY)-windows-amd64.exe ./cmd/memex-mcp

test:
	go test ./...

clean:
	rm -f $(CLI_BINARY)
	rm -rf $(DIST_DIR)
	rm -rf $(BIN_DIR)
