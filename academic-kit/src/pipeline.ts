import { AudioWaveform, Binary, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react'

export const pipelineStages = [
  { id: 'fingerprint', label: 'بصمة الإطار', caption: 'ربط بالسياق', icon: Fingerprint },
  { id: 'kdf', label: 'اشتقاق 3 مفاتيح', caption: 'فصل المجالات', icon: KeyRound },
  { id: 'cipher', label: 'SPN + CBC', caption: 'سرّية وانتشار', icon: Binary },
  { id: 'payload', label: 'HMAC + حمولة', caption: 'توثيق قبل الفك', icon: ShieldCheck },
  { id: 'audio', label: 'مواضع + LSB', caption: 'إخفاء داخل PCM', icon: AudioWaveform },
] as const

