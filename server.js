require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', '*'],
  credentials: true
}));
app.use(express.json());

// SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// EMAIL
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// SUBMIT CASE
app.post('/api/submit-case', async (req, res) => {
  try {
    const {
      bedrijfsnaam, contactpersoon, email_bedrijf, telefoon_bedrijf,
      debiteur_naam, debiteur_contactpersoon, email_debiteur, telefoon_debiteur,
      factuurnummer, bedrag, factuurdatum, vervaldatum, omschrijving,
      type_indiening, reden_wanbetaling, extra_informatie
    } = req.body;

    // Categorize with Claude
    let categorie = 'betaling_vergeten';
    if (reden_wanbetaling) {
      if (reden_wanbetaling.toLowerCase().includes('dispute') || reden_wanbetaling.toLowerCase().includes('niet eens')) {
        categorie = 'dispute';
      } else if (reden_wanbetaling.toLowerCase().includes('geen contact') || reden_wanbetaling.toLowerCase().includes('niet bereikbaar')) {
        categorie = 'geen_communicatie';
      } else if (reden_wanbetaling.toLowerCase().includes('financieel') || reden_wanbetaling.toLowerCase().includes('moeilijk')) {
        categorie = 'financiele_moeilijkheden';
      }
    }

    // Insert case
    const { data: caseData, error: caseError } = await supabase
      .from('cases')
      .insert([{
        bedrijfsnaam, contactpersoon, email_bedrijf, telefoon_bedrijf,
        debiteur_naam, debiteur_contactpersoon, email_debiteur, telefoon_debiteur,
        factuurnummer, bedrag: parseFloat(bedrag), factuurdatum, vervaldatum, omschrijving,
        type_indiening, reden_wanbetaling, extra_informatie,
        email_categorie: categorie,
        status: 'submitted'
      }])
      .select();

    if (caseError) throw caseError;
    const caseId = caseData[0].id;

    // Send email immediately
    const { data: templates } = await supabase
      .from('email_templates')
      .select('*')
      .eq('categorie', categorie)
      .single();

    if (templates) {
      const template = templates;
      const subject = template.subject_template
        .replace(/{{factuurnummer}}/g, factuurnummer)
        .replace(/{{bedrag}}/g, bedrag)
        .replace(/{{debiteur_naam}}/g, debiteur_naam);

      const body = template.body_template
        .replace(/{{factuurnummer}}/g, factuurnummer)
        .replace(/{{bedrag}}/g, bedrag)
        .replace(/{{debiteur_naam}}/g, debiteur_naam)
        .replace(/{{debiteur_contactpersoon}}/g, debiteur_contactpersoon)
        .replace(/{{bedrijfsnaam}}/g, bedrijfsnaam)
        .replace(/{{contactpersoon}}/g, contactpersoon)
        .replace(/{{email_bedrijf}}/g, email_bedrijf)
        .replace(/{{telefoon_bedrijf}}/g, telefoon_bedrijf)
        .replace(/{{omschrijving}}/g, omschrijving);

      await emailTransporter.sendMail({
        from: email_bedrijf,
        to: email_debiteur,
        subject: subject,
        html: body,
        text: body
      });

      await supabase
        .from('email_logs')
        .insert([{
          case_id: caseId,
          recipient_email: email_debiteur,
          subject: subject,
          status: 'sent'
        }]);

      await supabase
        .from('cases')
        .update({ email_sent_at: new Date().toISOString(), status: 'email_sent' })
        .eq('id', caseId);
    }

    // Create campaign
    await supabase
      .from('email_campaigns')
      .insert([{
        case_id: caseId,
        debiteur_email: email_debiteur,
        current_step: 1,
        status: 'sent',
        email_1_sent_at: new Date().toISOString()
      }]);

    res.json({
      success: true,
      message: 'Case submitted successfully',
      caseId: caseId,
      categorie: categorie
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET CASES
app.get('/api/cases', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET CAMPAIGNS
app.get('/api/campaigns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET TEMPLATES
app.get('/api/templates', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_templates')
      .select('*');

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE TEMPLATE
app.put('/api/templates/:categorie', async (req, res) => {
  try {
    const { categorie } = req.params;
    const { subject_template, body_template, tone } = req.body;

    const { data, error } = await supabase
      .from('email_templates')
      .update({ subject_template, body_template, tone, updated_at: new Date() })
      .eq('categorie', categorie)
      .select();

    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// STATS
app.get('/api/stats', async (req, res) => {
  try {
    const { data: cases } = await supabase.from('cases').select('*');
    const { data: campaigns } = await supabase.from('email_campaigns').select('*');
    const { data: logs } = await supabase.from('email_logs').select('*');

    res.json({
      cases: {
        total: cases?.length || 0,
        by_category: {}
      },
      emails: {
        total: logs?.length || 0,
        by_status: {}
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
