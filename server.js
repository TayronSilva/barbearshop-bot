import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import cron from "node-cron";
import dotenv from "dotenv";
import { connectDB } from "./database/connect.js";
import Agendamento from "./models/Agendamento.js";

dotenv.config();

const { Client, LocalAuth } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

connectDB();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
});

client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
    console.log("🤖 Bot WhatsApp conectado e pronto!");
    client.sendMessage(process.env.OWNER_NUMBER, "✅ O JotaBarber está online e pronto para agendar! 💈\n\nDigite *admin* para ver o menu de gerenciamento.");
});

client.initialize(); 

function parseDateTime(text) {
    try {
        text = text.toLowerCase().trim();
        const now = new Date();

        if (text.includes("amanhã")) {
            now.setDate(now.getDate() + 1);
        } else if (text.includes("depois de amanhã")) {
            now.setDate(now.getDate() + 2);
        } else if (text.includes("sexta")) {
            const currentDay = now.getDay();
            const friday = 5; 
            const daysToAdd = friday > currentDay ? friday - currentDay : (7 - currentDay + friday);
            now.setDate(now.getDate() + daysToAdd);
        }

        const match = text.match(/(\d{1,2})[:h](\d{2})?/);
        if (!match) return null;

        let hour = parseInt(match[1]);
        let minute = parseInt(match[2] || "0");

        const result = new Date(now);
        result.setHours(hour, minute, 0, 0);

        if (result < new Date() && !text.includes("amanhã") && !text.includes("sexta")) {
             result.setDate(result.getDate() + 1);
        }

        return result;
    } catch (err) {
        console.error("Erro no parseDateTime:", err);
        return null;
    }
}

/**
 * Checa a disponibilidade e retorna o próximo slot livre (assumindo 1h de serviço).
 * @param {Date} requestedDateTime - Data e hora inicial a ser checada.
 * @returns {Promise<Date>} - O primeiro horário disponível encontrado.
 */
async function findNextAvailableSlot(requestedDateTime) {
    let currentSlot = new Date(requestedDateTime);
    let isBooked = true;

    // Garante que a checagem comece no futuro
    if (currentSlot < new Date()) {
        // Arredonda para o próximo slot de 30 minutos ou hora cheia
        currentSlot.setMinutes(currentSlot.getMinutes() < 30 ? 30 : 60, 0, 0);
        if (currentSlot.getMinutes() === 0) {
             currentSlot.setHours(currentSlot.getHours() + 1);
        }
    }

    while (isBooked) {
        // Definimos o slot de 1 hora a ser checado
        const slotStart = new Date(currentSlot);
        const slotEnd = new Date(currentSlot);
        slotEnd.setMinutes(slotEnd.getMinutes() + 59); // Slot de 1 hora (ex: 11:00 até 11:59)

        // Busca por qualquer agendamento ATIVO (pendente ou confirmado) que comece dentro deste slot de 1h
        // Se um agendamento existe, ele BLOQUEIA o horário.
        const existingBooking = await Agendamento.findOne({
            datetime: { 
                $gte: slotStart, 
                $lt: slotEnd 
            },
            status: { $in: ["pendente", "confirmado"] }
        });

        if (existingBooking) {
            // Se o horário estiver ocupado, move para o próximo slot de 1 hora
            currentSlot.setHours(currentSlot.getHours() + 1);
            currentSlot.setMinutes(0, 0, 0); // Garante que o novo slot seja em hora cheia
            isBooked = true;
        } else {
            // Slot está livre
            isBooked = false;
        }
    }
    return currentSlot;
}

const dono = process.env.OWNER_NUMBER;

client.on("message", async (msg) => {
    const texto = msg.body.toLowerCase().trim();
    const numero = msg.from;

    if (numero === dono) {
        
        if (texto === "admin") {
            return msg.reply(
                "👑 Menu de Administrador 👑\n\n" +
                "Digite o que você deseja fazer:\n\n" +
                "*listar hoje*: Ver agendamentos para o dia de hoje.\n" +
                "*listar futuros*: Ver todos os agendamentos futuros (pendentes e confirmados).\n" +
                "*confirmar [ID]*: Confirma agendamento (Ex: confirmar 55219...). (Ainda funciona respondendo a mensagem)\n" +
                "*cancelar [ID]*: Cancela e *exclui* agendamento.\n\n" +
                "Atenção: Agendamentos cancelados são *excluídos*."
            );
        }

        if (texto.startsWith("listar")) {
            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);
            
            let query = {};
            let titulo = "📋 Agendamentos Futuros (Ativos):";

            if (texto === "listar hoje") {
                const amanha = new Date(hoje);
                amanha.setDate(amanha.getDate() + 1);
                query = { 
                    datetime: { $gte: hoje, $lt: amanha },
                    status: { $in: ["pendente", "confirmado"] }
                };
                titulo = "📋 Agendamentos para HOJE:";
            } else if (texto === "listar futuros") {
                query = { 
                    datetime: { $gte: hoje },
                    status: { $in: ["pendente", "confirmado"] }
                };
            }
            
            const agendamentos = await Agendamento.find(query).sort({ datetime: 1 });

            if (agendamentos.length === 0) {
                return msg.reply(`📭 ${titulo}\nNenhum agendamento encontrado.`);
            }

            const lista = agendamentos
                .map(
                    (a) =>
                        `[${a.nome || 'N/D'}] [${a._id.toString().substring(0, 4)}] ${new Date(a.datetime).toLocaleString('pt-BR')} | Status: ${a.status}`
                )
                .join("\n");
            
            return msg.reply(`${titulo}\n\n${lista}`);
        }
        
        if (texto.startsWith("confirmar")) {
            const partes = texto.split(" ");
            const clienteId = partes[1];

            const agendamento = await Agendamento.findOne({
                telefone: clienteId, 
                status: "pendente", 
            });

            if (agendamento) {
                agendamento.status = "confirmado"; 
                await agendamento.save();

                client.sendMessage(clienteId, "✅ Seu agendamento foi *confirmado*! 💈");
                msg.reply(`✅ Agendamento de ${agendamento.nome || clienteId} foi confirmado com sucesso!`);
            } else {
                msg.reply("❌ Nenhum agendamento pendente encontrado para este número.");
            }
            return;
        }

        if (texto.startsWith("cancelar")) {
            const partes = texto.split(" ");
            const clienteId = partes[1];
            
            const agendamento = await Agendamento.findOne({
                telefone: clienteId, 
                status: { $in: ["pendente", "confirmado"] } 
            });
            
            if (agendamento) {
                await Agendamento.deleteOne({ _id: agendamento._id });
                client.sendMessage(clienteId, "❌ Seu agendamento foi *cancelado* pelo barbeiro e *removido* do sistema.");
                msg.reply(`❌ Agendamento de ${agendamento.nome || clienteId} foi cancelado e *excluído* do MongoDB.`);
            } else {
                 msg.reply("❌ Nenhum agendamento ativo encontrado para este número.");
            }
            
            return;
        }
    }

    // Lógica para o cliente comum
    if (["oi", "menu", "olá"].includes(texto)) {
        msg.reply(
            "Olá! ✂️ Seja bem-vindo à *JotaBarber!*\n\n" +
            "1 - Agendar um corte\n" +
            "2 - Consultar/Cancelar horário\n" +
            "3 - Falar com atendente\n\n" +
            "Digite o número da opção desejada."
        );
        return;
    }

    if (texto === "1") {
        msg.reply(
            "🗓️ Perfeito! Vamos marcar seu horário.\nPor favor, me diga o dia e hora que você prefere (exemplo: sexta às 15:30 ou amanhã 10:00)."
        );
        return;
    }

    if (texto === "2") {
        const agendamentos = await Agendamento.find({
            telefone: numero, 
            status: { $in: ["pendente", "confirmado"] }
        }).sort({ datetime: 1 });

        if (agendamentos.length === 0) {
            msg.reply("📅 Você ainda não possui nenhum horário marcado.");
        } else {
            const lista = agendamentos
                .map(
                    (a) =>
                        `📋 ${new Date(a.datetime).toLocaleString('pt-BR')} (${a.status})`
                )
                .join("\n");
            msg.reply(`📋 Seus horários marcados:\n${lista}`);
        }
        return;
    }

    if (texto === "3") {
        msg.reply("💈 Um atendente humano entrará em contato com você em breve!");
        return;
    }

    if (texto === "cancelar") {
        const agendamento = await Agendamento.findOne({
            telefone: numero, 
            status: "pendente", 
        }).sort({ datetime: -1 });

        if (agendamento) {
            await Agendamento.deleteOne({ _id: agendamento._id });
            msg.reply("✅ Seu agendamento foi cancelado com sucesso e *removido* do sistema.");
        } else {
            msg.reply("❌ Você não possui nenhum agendamento pendente para cancelar.");
        }
        return;
    }

    // Captura tentativa de agendamento (AGORA COM VERIFICAÇÃO DE SLOT)
    if (texto.includes("às") || texto.includes(":") || texto.includes("h")) {
        const dataTexto = msg.body;
        
        const dataAgendada = parseDateTime(dataTexto); 
        
        if (!dataAgendada) {
            msg.reply("❌ Não consegui entender a data e hora. Tente um formato mais claro, como: 'amanhã às 14:00' ou 'sexta 10:30'.");
            return;
        }
        
        const contato = await client.getContactById(numero);
        const nomeCliente = contato.pushname || contato.name || 'Cliente Desconhecido';
        
        // --- 🎯 LÓGICA DE VERIFICAÇÃO DE DISPONIBILIDADE ---
        const dataDisponivel = await findNextAvailableSlot(dataAgendada);

        if (dataDisponivel.getTime() !== dataAgendada.getTime()) {
            const dataIndisponivelFormatada = dataAgendada.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
            const dataDisponivelFormatada = dataDisponivel.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
            
            // Retorna a sugestão sem salvar
            return msg.reply(
                `⛔️ Sentimos muito, mas o horário de *${dataIndisponivelFormatada}* já está *reservado*!
                \nO próximo horário disponível é às *${dataDisponivelFormatada}*.
                \nPor favor, digite o horário disponível (*${dataDisponivelFormatada.split(', ')[1]}*) para confirmar seu agendamento, ou escolha outro dia/hora.`
            );
        }
        
        // Horário disponível, prossegue com o agendamento
        const dataFormatada = dataAgendada.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

        const novoAgendamento = new Agendamento({
            nome: nomeCliente, 
            telefone: numero,
            datetime: dataAgendada,
            status: "pendente", 
        });

        await novoAgendamento.save();

        msg.reply(
            `✅ Agendamento pré-registrado para *${dataFormatada}*.\n\nPor favor, aguarde a confirmação do barbeiro 💈. (Status: pendente)`
        );

        client.sendMessage(
            dono,
            `🚨 *NOVO AGENDAMENTO PENDENTE* 🚨\n` +
            `*Nome:* ${nomeCliente}\n` + 
            `Cliente: ${numero}\n` +
            `Horário sugerido: ${dataAgendada.toLocaleString('pt-BR')}\n` +
            `Texto Original: ${dataTexto}\n\n` +
            `Para confirmar, digite: *confirmar ${numero}*\nPara cancelar, digite: *cancelar ${numero}*`
        );
        return;
    }
});

cron.schedule("0 9 * * *", () => {
    console.log("⏰ Lembrete diário (exemplo)");
});

// 📌 NOVO ENDPOINT DE PING ADICIONADO AQUI
app.get("/ping", (req, res) => {
    res.send("🤖 OK");
});

app.get("/", (req, res) => {
    res.send("🤖 JotaBarber Bot está rodando com sucesso!");
});

app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));