import { Router } from 'express';
import { submitKyc, getKycStatus } from './kyc.controller';

const router = Router();

router.post('/submit', submitKyc);
router.get('/status', getKycStatus);

export default router;
