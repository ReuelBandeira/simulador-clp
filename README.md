# CLP Simulator — Modbus TCP Workbench

Simulador genérico de CLPs em Node.js e TypeScript, com painel React e múltiplos servidores Modbus TCP. Cada estação possui memória, porta, Unit ID, comportamentos, histórico e logs independentes.

O projeto não representa uma máquina ou integração específica. Os fluxos são construídos combinando comportamentos configuráveis e endereços Modbus livres.

## Executar

Requer Node.js 22.12 ou superior.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

Copie `.env.example` para `.env` quando precisar alterar as configurações. Use `MODBUS_HOST=0.0.0.0` para aceitar conexões pela rede. O painel abre em `http://127.0.0.1:3100` por padrão.

## Bancada multi-CLP

Use **Nova CLP** para cadastrar quantas estações forem necessárias. Cada cadastro é persistido em `machines.json`; IDs e portas não podem se repetir.

O painel é dividido em abas:

- **Visão geral**: listener, contadores RX/TX e diagnóstico;
- **Registradores**: leitura e escrita de holding registers em decimal, hexadecimal, binário e ASCII;
- **Coils**: alteração direta de sinais digitais;
- **Comportamentos**: módulos genéricos combináveis;
- **Conexão e clientes**: fabricante, modelo, listener, endpoints de rede, sessões TCP ativas e tráfego;
- **Polling e falhas**: atualização do painel, latência e injeção de falhas;
- **Cenários avançados**: escritas por intervalo ou condição;
- **Histórico**: gráfico de memória e tráfego;
- **Logs**: eventos recebidos e enviados, com exportação CSV e JSON.

O nome visível da estação é editável. O ID técnico usado pela API permanece estável.

Fabricante e modelo também podem ser alterados diretamente no cabeçalho. Avisos, erros e confirmações de sucesso são exibidos com Toastify; ações destrutivas continuam utilizando o modal global de confirmação.

## Comportamentos

Uma estação pode executar vários módulos ao mesmo tempo:

- **Entrada e saída digital**: pulso periódico com tempos ligado e desligado;
- **Processo analógico**: rampa, onda senoidal ou valor aleatório dentro de uma faixa;
- **Máquina de estados**: Parado, Iniciando, Executando, Finalizando e Falha;
- **Ciclo e handshake**: Request, Busy, Done, Ack e Error em endereços configuráveis;
- **Contador e encoder**: contagem por borda de subida, passo, reset e rollover;
- **Alarmes e intertravamentos**: limites baixo/alto, modo momentâneo ou memorizado;
- **Heartbeat e watchdog**: contador periódico e coil de saúde.

Os módulos são independentes do fabricante. A interface avisa quando dois módulos escrevem no mesmo endereço; nesse caso, a última escrita do ciclo de avaliação prevalece.

## Templates

Fabricante e modelo controlam aliases e endereçamento exibidos no painel. Atualmente estão disponíveis:

- **Genérico / Genérico**: endereços Modbus puros;
- **Delta / Genérico**: D0 no holding 4096 e M0 no coil 2048;
- **Mitsubishi / Genérico**: D0 no holding 0 e M0 no coil 8192.

Modelos reais podem ser adicionados futuramente sem mudar o motor de comportamentos.

## Memória e funções Modbus

Cada estação oferece:

- 16.384 coils/discrete inputs;
- 8.192 holding/input registers de 16 bits;
- FC01 e FC02 para leitura digital;
- FC03 e FC04 para leitura de words;
- FC05 para escrita de coil;
- FC06 e FC16 para escrita de registradores.

A ordem AB/BA troca os bytes dentro de cada word exibida e escrita pela bancada. A moldura Modbus TCP permanece no formato do protocolo.

A coluna ASCII representa os dois bytes da word após a aplicação da ordem AB/BA. Cada byte entre 32 e 126 aparece como caractere ASCII; bytes de controle ou não imprimíveis aparecem como `·`. A entrada de valores decimais aceita apenas números e os separadores vírgula, espaço ou ponto e vírgula. Também é possível zerar todos os holding registers, preservando coils e configurações.

## Cenários, falhas e tempo real

Cenários avançados escrevem em um coil ou registrador por intervalo ou quando outro endereço alcança um valor. A injeção de falhas oferece perda de pacotes, desconexão e corrupção de leituras.

O painel recebe atualizações incrementais por WebSocket. Se o canal cair, utiliza consultas HTTP periódicas como fallback. Cada estação mantém até 200 logs e 300 pontos de histórico em memória.

Com `MODBUS_HOST=0.0.0.0`, a aba **Conexão e clientes** lista os endereços IPv4 que podem ser usados por outro computador. Conexões, desconexões e frames MBAP recebidos aparecem em tempo real; o log funcional também registra cada operação RX/TX executada pelo servidor.

Cada endpoint pode ser copiado pelo painel e recebe uma classificação estimada de interface física, virtual/VPN ou não identificada. No Windows, **Verificar/liberar firewall** procura uma regra própria para a porta e, somente quando ela não existe, solicita elevação administrativa para criá-la.

Leituras FC01–FC04 são contabilizadas como polling provável e escritas FC05/FC06/FC16 como comandos. Essa separação é heurística: o protocolo não informa a intenção do cliente, então uma leitura manual também pertence ao grupo de leituras.

Um cliente não precisa de comportamento ativo para alterar a memória: FC05 escreve um coil, FC06 escreve um holding register e FC16 escreve vários holding registers. Um comportamento configurado no mesmo endereço pode sobrescrever posteriormente o valor do cliente.

O servidor responde normalmente às funções suportadas e envia exceção `Illegal Function` para função desconhecida. O código Modbus de exceção `Acknowledge` não é usado como confirmação genérica, pois no protocolo ele indica processamento demorado, não sucesso de qualquer requisição.

O diagnóstico rápido abre uma conexão Modbus local real e verifica FC01, FC02, FC03, FC04, FC05, FC06 e FC16. Ele escolhe endereços não usados por comportamentos ou cenários, mede cada etapa e restaura os valores originais ao terminar, inclusive quando uma verificação falha.

## Testes

```powershell
npm.cmd test
```

Os testes validam o servidor Modbus genérico, isolamento entre estações, templates, falhas, autoteste, rastreamento de clientes e todos os comportamentos configuráveis.
