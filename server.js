require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*',
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

    // Categorize
    let categorie = 'betaling_vergeten';
    if (reden_wanbetaling) {
      const reden = reden_wanbetaling.toLowerCase();
      if (reden.includes('dispute') || reden.includes('niet eens')) {
        categorie = 'dispute';
      } else if (reden.includes('geen contact') || reden.includes('niet bereikbaar')) {
        categorie = 'geen_communicatie';
      } else if (reden.includes('financieel') || reden.includes('moeilijk')) {
        categorie = 'financiele_moeilijkheden';
      }
    }

    // Insert case in Supabase
    const { data: caseData, error: caseError } = await supabase
      .from('cases')
      .insert([{
        bedrijfsnaam, contactpersoon, email_bedrijf, telefoon_bedrijf,
        debiteur_naam, debiteur_contactpersoon, email_debiteur, telefoon_debiteur,
        bedrag: bedrag ? parseFloat(bedrag) : 0,
        type_indiening, reden_wanbetaling, extra_informatie,
        email_categorie: categorie,
        status: 'submitted'
      }])
      .select();

    if (caseError) {
      console.error('Case insert error:', caseError);
      throw caseError;
    }
    
    const caseId = caseData[0].id;
    console.log('Case inserted with ID:', caseId);

    // Send email (with try/catch so failure doesn't crash)
    try {
      const { data: templates } = await supabase
        .from('email_templates')
        .select('*')
        .eq('categorie', categorie)
        .single();

      if (templates) {
        const subject = templates.subject_template
          .replace(/{{factuurnummer}}/g, factuurnummer || '')
          .replace(/{{bedrag}}/g, bedrag || '')
          .replace(/{{debiteur_naam}}/g, debiteur_naam || '');

        const body = templates.body_template
          .replace(/{{factuurnummer}}/g, factuurnummer || '')
          .replace(/{{bedrag}}/g, bedrag || '')
          .replace(/{{debiteur_naam}}/g, debiteur_naam || '')
          .replace(/{{debiteur_contactpersoon}}/g, debiteur_contactpersoon || '')
          .replace(/{{bedrijfsnaam}}/g, bedrijfsnaam || '')
          .replace(/{{contactpersoon}}/g, contactpersoon || '')
          .replace(/{{email_bedrijf}}/g, email_bedrijf || '')
          .replace(/{{telefoon_bedrijf}}/g, telefoon_bedrijf || '')
          .replace(/{{omschrijving}}/g, omschrijving || '');

        try {
          await emailTransporter.sendMail({
            from: process.env.SMTP_FROM,
            to: email_debiteur,
            subject: subject,
            html: body,
            text: body
          });
          console.log('Email sent to:', email_debiteur);

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
        } catch (emailError) {
          console.error('Email send error:', emailError.message);
        }
      }
    } catch (templateError) {
      console.error('Template error:', templateError.message);
    }

    // Create campaign (with try/catch)
    try {
      await supabase
        .from('email_campaigns')
        .insert([{
          case_id: caseId,
          debiteur_email: email_debiteur,
          current_step: 1,
          status: 'sent',
          email_1_sent_at: new Date().toISOString()
        }]);
    } catch (campaignError) {
      console.error('Campaign error:', campaignError.message);
    }

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
