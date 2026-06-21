import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import kycRoutes from './modules/kyc/kyc.routes';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/api/kyc', kycRoutes);

app.get('/', (req, res) => {
  res.send('✅ WiseSell Backend চলছে... KYC সিস্টেম রেডি');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
