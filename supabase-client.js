const { createClient } = require("@supabase/supabase-js");

const config = require("./cloud-config.js");

const supabase = createClient(
    config.supabaseUrl,
    config.supabaseKey
);

module.exports = supabase;