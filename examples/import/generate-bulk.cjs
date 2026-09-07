#!/usr/bin/env node
// Generates examples/bulk-import.json with 200000 conversations.
// Run: node examples/import/generate-bulk.cjs

const fs = require('fs');
const path = require('path');

// Indonesian first names (50)
const firstNamesId = [
  'Adi', 'Agus', 'Ahmad', 'Aji', 'Andi', 'Andika', 'Ananda', 'Andra', 'Anton', 'Arief',
  'Budi', 'Bayu', 'Bagus', 'Bintang', 'Baskoro', 'Beni', 'Bimo', 'Bambang', 'Basuki', 'Bejo',
  'Candra', 'Cahyo', 'Dimas', 'Dewa', 'Dian', 'Dinda', 'Doni', 'Dedi', 'Dion', 'Daru',
  'Eka', 'Eko', 'Endang', 'Edi', 'Fajar', 'Fahmi', 'Fikri', 'Faris', 'Fitri', 'Firman',
  'Gading', 'Galih', 'Gita', 'Guntur', 'Hadi', 'Hendra', 'Haryanto', 'Husain', 'Haris', 'Hasan',
];

// Indonesian last names (50)
const lastNamesId = [
  'Pratama', 'Santoso', 'Wibowo', 'Hidayat', 'Putra', 'Saputra', 'Kusuma', 'Susanto', 'Wijaya', 'Nugraha',
  'Gunawan', 'Setiawan', 'Prabowo', 'Sari', 'Nurhaliza', 'Lestari', 'Permana', 'Sari', 'Hidayat', 'Saputra',
  'Susanto', 'Wijaya', 'Saputra', 'Gunawan', 'Pratama', 'Santoso', 'Wibowo', 'Hidayat', 'Putra', 'Saputra',
  'Kusuma', 'Susanto', 'Saputra', 'Wijaya', 'Nugraha', 'Gunawan', 'Setiawan', 'Prabowo', 'Sari', 'Nurhaliza',
  'Lestari', 'Permana', 'Sari', 'Hidayat', 'Saputra', 'Susanto', 'Wijaya', 'Saputra', 'Gunawan', 'Pratama',
];

// Malaysian first names (50)
const firstNamesMy = [
  'Ahmad', 'Muhammad', 'Mohd', 'Abu', 'Ali', 'Mazlan', 'Razak', 'Ismail', 'Hashim', 'Othman',
  'Abdul', 'Salleh', 'Amir', 'Aiman', 'Aqil', 'Azmi', 'Adam', 'Affendi', 'Ibrahim', 'Irfan',
  'Jafri', 'Jalil', 'Johan', 'Jefri', 'Kamarul', 'Khalid', 'Khairul', 'Lai', 'Lim', 'Leong',
  'Loh', 'Ng', 'Nordin', 'Noor', 'Nasir', 'Omar', 'Osman', 'Rahman', 'Rusli', 'Salleh',
  'Suhaimi', 'Hafiz', 'Faizal', 'Zulkifli', 'Nadia', 'Aisyah', 'Syafiqah', 'Hidayah', 'Zainab', 'Amirul',
];

// Malaysian last names (50)
const lastNamesMy = [
  'bin Haji', 'bin Sulaiman', 'bin Ismail', 'bin Hashim', 'bin Omar', 'bin Abdullah', 'bin Ramli', 'bin Mohd', 'bin Razak', 'bin Yusof',
  'bin Karim', 'bin Salleh', 'bin Hamid', 'bin Ali', 'bin Mustafa', 'bin Hussain', 'bin Sidek', 'bin Kassim', 'bin Awang', 'bin Rahman',
  'bin David', 'bin Peter', 'bin John', 'bin Lim', 'bin Tan', 'bin Chua', 'bin Ong', 'bin Ng', 'bin Yeoh', 'bin Lee',
  'bin Koh', 'bin Teh', 'bin Goh', 'bin Chong', 'bin Wong', 'bin Wee', 'bin Soo', 'bin Low', 'bin Sim', 'bin Tan',
  'bin Haji', 'bin Sulaiman', 'bin Ismail', 'bin Hashim', 'bin Omar', 'bin Abdullah', 'bin Ramli', 'bin Mohd', 'bin Razak', 'bin Yusof',
];

// Singaporean Chinese first names (50)
const firstNamesCn = [
  'Wei', 'Jia', 'Xin', 'Yi', 'Li', 'Min', 'Hui', 'Mei', 'Ling', 'Yan',
  'Ting', 'Hui', 'Ying', 'Jia', 'Xin', 'Yi', 'Li', 'Min', 'Hui', 'Mei',
  'Ling', 'Yan', 'Ting', 'Hui', 'Ying', 'Jia', 'Xin', 'Yi', 'Li', 'Min',
  'Hui', 'Mei', 'Ling', 'Yan', 'Ting', 'Hui', 'Ying', 'Jia', 'Xin', 'Yi',
  'Li', 'Min', 'Hui', 'Mei', 'Ling', 'Yan', 'Ting', 'Hui', 'Ying', 'Mei',
];

// Singaporean Chinese last names (50)
const lastNamesCn = [
  'Tan', 'Lim', 'Chong', 'Lee', 'Wong', 'Goh', 'Low', 'Sim', 'Chua', 'Wee',
  'Yeo', 'Tay', 'Teo', 'Koh', 'Phua', 'Seow', 'Chew', 'Loh', 'Chen', 'Wang',
  'Liu', 'Chen', 'Wong', 'Lim', 'Tan', 'Goh', 'Chong', 'Lee', 'Low', 'Sim',
  'Chua', 'Wee', 'Yeo', 'Tay', 'Teo', 'Koh', 'Phua', 'Seow', 'Chew', 'Loh',
  'Chen', 'Wang', 'Liu', 'Chen', 'Wong', 'Lim', 'Tan', 'Goh', 'Chong', 'Lee',
];

// Normalize display-name components into RFC-compatible email local parts.
function emailLocalPart(...parts) {
  return parts
    .join('.')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function uniqueValues(values) {
  return [...new Set(values)];
}

// Extra given-name components make the generated customers more varied while
// keeping the output deterministic and realistic for each region.
const middleNamesId = [
  'Adit', 'Bagas', 'Bayu', 'Cahya', 'Daffa', 'Galang', 'Jaya', 'Kurnia', 'Maulana', 'Naufal',
  'Pranata', 'Raka', 'Rangga', 'Rizky', 'Surya', 'Tegar', 'Wahyu', 'Yoga', 'Yudha', 'Zaki',
];

const middleNamesMy = [
  'Hakim', 'Haziq', 'Faris', 'Fauzan', 'Firdaus', 'Hilmi', 'Imran', 'Johan', 'Luqman', 'Naim',
  'Nazim', 'Qasim', 'Rafiq', 'Rashid', 'Safwan', 'Shafiq', 'Syahmi', 'Taufiq', 'Yusri', 'Zamir',
];

const middleNamesCn = [
  'Jun', 'Jie', 'Jing', 'Kai', 'Kang', 'Kian', 'Kun', 'Ming', 'Qiang', 'Rui',
  'Shan', 'Sheng', 'Tao', 'Tian', 'Wen', 'Xiang', 'Yang', 'Yong', 'Zhen', 'Zhi',
];

// Select a deterministic combination from the component lists. The cartesian
// product gives every region far more combinations than its 1,000 customers.
function nameAt(index, firstNames, middleNames, lastNames, lastNameFirst = false) {
  const first = uniqueValues(firstNames);
  const middle = uniqueValues(middleNames);
  const last = uniqueValues(lastNames);
  const firstIndex = index % first.length;
  const lastIndex = Math.floor(index / first.length) % last.length;
  const middleIndex = Math.floor(index / (first.length * last.length)) % middle.length;

  return lastNameFirst
    ? [last[lastIndex], first[firstIndex], middle[middleIndex]]
    : [first[firstIndex], middle[middleIndex], last[lastIndex]];
}

// Generate customers: 1000 Indonesian, 1000 Malaysian, 1000 Singaporean = 3000
const customers = [];

for (let i = 0; i < 1000; i++) {
  const nameParts = nameAt(i, firstNamesId, middleNamesId, lastNamesId);
  customers.push({
    phone: 6278910000 + i,
    name: nameParts.join(' '),
    email: `${emailLocalPart(...nameParts)}${i + 1}@example.com`,
  });
}

for (let i = 0; i < 1000; i++) {
  const nameParts = nameAt(i, firstNamesMy, middleNamesMy, lastNamesMy);
  customers.push({
    phone: 6278911000 + i,
    name: nameParts.join(' '),
    email: `${emailLocalPart(...nameParts)}${i + 1}@example.com`,
  });
}

for (let i = 0; i < 1000; i++) {
  const nameParts = nameAt(i, firstNamesCn, middleNamesCn, lastNamesCn, true);
  customers.push({
    phone: 6278912000 + i,
    name: nameParts.join(' '),
    email: `${emailLocalPart(...nameParts)}${i + 1}@example.com`,
  });
}

// Generate agents (200)
const agents = [];
for (let i = 0; i < 200; i++) {
  const teams = ['Support', 'Billing', 'Technical', 'Sales', 'Account'];
  agents.push({
    email: `agent${String(i + 1).padStart(3, '0')}@company.com`,
    name: `Agent ${i + 1}`,
    team: teams[i % teams.length],
  });
}

const tags = ['Claims', 'Policy Inquiry', 'Premium Payment', 'Policy Renewal', 'Coverage Question', 'Claim Status', 'Beneficiary Update', 'Policy Cancellation', 'Document Request', 'Complaint'];

const agentPhrases = [
  'Thank you for calling, how can I help you today?',
  'I understand your concern. Let me look into your policy.',
  'Can you please verify your policy number?',
  'I can see the claim on my end. Let me check the status.',
  'Is there anything else I can help you with?',
  'Your claim has been processed and payment will be issued in 5-7 business days.',
  'I apologize for the delay in processing.',
  'Let me check the details of your coverage.',
  'I have escalated this to our claims specialist team.',
  'Your policy has been updated successfully.',
  'Let me explain the next steps for your claim.',
  'I have updated your beneficiary information.',
];

const customerPhrases = [
  'Hi, I have a question about my policy.',
  'I need to file a claim for an incident.',
  'Can you tell me what my policy covers?',
  'When will my claim be processed?',
  'I received a denial letter and want to appeal.',
  'I need to update my payment method.',
  'I want to add a family member to my policy.',
  'Thank you, that resolves my question.',
  'I have been waiting for my claim decision.',
  'My premium seems incorrect this month.',
  'I want to cancel my policy.',
  'I need a copy of my policy documents.',
];

function makeConversation(index, includeMetrics, includeTranscript) {
  const agent = agents[index % agents.length];
  const customer = customers[index % customers.length];
  const tag = tags[index % tags.length];

  // Spread over ~210 days (Jan 1 to Jul 20, 2026)
  const baseDate = new Date('2026-01-01T08:00:00Z');
  baseDate.setMinutes(baseDate.getMinutes() + index * 1.5);
  const duration = 60 + (index % 600);
  const endDate = new Date(baseDate.getTime() + duration * 1000);

  const conv = {
    conversation: {
      customer: customer,
      agent: agent,
      channel: 'call',
      started_at: baseDate.toISOString(),
      ended_at: endDate.toISOString(),
      status: index % 7 === 0 ? 'escalated' : 'resolved',
      tags: [tag, tags[(index + 3) % tags.length]].slice(0, 1 + (index % 2)),
      external_id: 'BULK2-' + String(index + 1).padStart(6, '0'),
    },
    audio: {
      url: '/audio/6a6236e2d57e5e6a1f6a78e8.wav',
      format: 'wav',
    },
  };

  if (includeTranscript) {
    const segCount = 4 + (index % 6);
    conv.transcript = [];
    for (let s = 0; s < segCount; s++) {
      const isAgent = s % 2 === 0;
      conv.transcript.push({
        speaker: isAgent ? 'agent' : 'customer',
        timestamp_seconds: s * 15,
        text: isAgent
          ? agentPhrases[s % agentPhrases.length]
          : customerPhrases[s % customerPhrases.length],
      });
    }
  }

  if (includeMetrics) {
    const score = +(((index % 20) - 10) / 10).toFixed(2);
    conv.metrics = {
      sentiment_score: score,
      sentiment_label: score > 0.3 ? 'positive' : score < -0.3 ? 'negative' : 'neutral',
      handle_time_seconds: duration,
      first_response_seconds: 3 + (index % 25),
    };
  }

  return conv;
}

const conversations = [];

// 50k with both metrics and transcript
for (let i = 0; i < 50000; i++) {
  conversations.push(makeConversation(i, true, true));
}

// 50k with transcript only
for (let i = 50000; i < 100000; i++) {
  conversations.push(makeConversation(i, false, true));
}

// 50k with metrics only
for (let i = 100000; i < 150000; i++) {
  conversations.push(makeConversation(i, true, false));
}

// 50k without metrics or transcript
for (let i = 150000; i < 200000; i++) {
  conversations.push(makeConversation(i, false, false));
}

const output = JSON.stringify({ conversations }, null, 2);
const outPath = path.join(__dirname, 'bulk-import.json');
fs.writeFileSync(outPath, output + '\n');
console.log('Generated ' + outPath + ' (' + conversations.length + ' conversations)');
