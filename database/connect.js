
import mongoose from 'mongoose';

/**
 * Conecta ao MongoDB Atlas usando a variável de ambiente MONGO_URI.
 * Garante que a aplicação pare se a conexão falhar.
 */
export async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/barbershop';
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB conectado');
  } catch (err) {
    console.error('❌ Erro conectando ao MongoDB:', err.message);
    process.exit(1);
  }
}
