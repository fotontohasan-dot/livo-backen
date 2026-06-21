import { Router } from 'express';
import { submitKyc, getKycStatus, upload } from './kyc.controller';

const router = Router();

router.post('/submit', upload.fields([
  { name: 'documentFront', maxCount: 1 },
  { name: 'documentBack', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), submitKyc);

router.get('/status', getKycStatus);

export default router;
