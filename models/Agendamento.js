import mongoose from 'mongoose'; 

const AgendamentoSchema = new mongoose.Schema({
    nome: { type: String, default: '' },
    telefone: { type: String, required: true },
    datetime: { type: Date, required: true },
    status: { type: String, enum: ['pendente','confirmado','cancelado','feito','no-show'], default: 'pendente' },
    reminderSent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Agendamento', AgendamentoSchema);

export default Booking;