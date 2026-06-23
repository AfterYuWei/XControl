FROM ubuntu:24.04

RUN rm -f /etc/apt/sources.list.d/* \
 && echo "deb http://mirrors.tencent.com/ubuntu/ noble main restricted universe multiverse" > /etc/apt/sources.list \
 && echo "deb http://mirrors.tencent.com/ubuntu/ noble-security main restricted universe multiverse" >> /etc/apt/sources.list \
 && echo "deb http://mirrors.tencent.com/ubuntu/ noble-updates main restricted universe multiverse" >> /etc/apt/sources.list \
 && echo "deb http://mirrors.tencent.com/ubuntu/ noble-backports main restricted universe multiverse" >> /etc/apt/sources.list

RUN apt-get update \
 && apt-get install -y wget unzip openssh-server curl git maven \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# 安装 Go 1.26.1
ENV GO_VERSION=1.26.1
RUN wget -O go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && tar -C /usr/local -xzf go.tar.gz \
 && rm go.tar.gz

# 设置 Go 环境变量
ENV PATH="/usr/local/go/bin:${PATH}"

# 创建 /ide_cnb 目录，用于安装 IDE，注意安装路径必须是这个，便于自动识别环境中支持哪些 ide
RUN mkdir -p /ide_cnb

# 安装 IntelliJ IDEA
RUN wget https://download.jetbrains.com/idea/ideaIU-2025.3.3.tar.gz
RUN tar -zxvf ideaIU-2025.3.3.tar.gz -C /ide_cnb

# 安装nodejs
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# 安装 code-server(VSCode WebIDE 支持)
RUN curl -fsSL https://code-server.dev/install.sh | sh \
  && code-server --install-extension redhat.vscode-yaml \
  && code-server --install-extension waderyan.gitblame \
  && code-server --install-extension mhutchie.git-graph \
  && code-server --install-extension donjayamanne.githistory \
  && code-server --install-extension tencent-cloud.coding-copilot \
  && code-server --install-extension vscjava.vscode-java-pack \
  && code-server --install-extension vue.volar

ENV LANG C.UTF-8