-- =============================================================================
-- TABEL 1: MASTER DATA TIKET KELUHAN PELANGGAN (208 Kolom Sesuai Export Web)
-- =============================================================================
CREATE TABLE IF NOT EXISTS "SQA_SUMBAGUT".inap_ticketing_customer_complain (
    order_id                                             VARCHAR(64) PRIMARY KEY       , -- [1] Order ID
    agent_name                                           TEXT                          , -- [2] Agent Name
    agnostic_flag_create_ticket_agnostic_flag            TEXT                          , -- [3] Agnostic Flag(Create Ticket_agnostic_flag)
    api_flag                                             TEXT                          , -- [4] api_flag
    app_name                                             TEXT                          , -- [5] App Name
    assign_to                                            TEXT                          , -- [6] Assign To
    assign_to_l2_l2_assign                               TEXT                          , -- [7] Assign to L2(L2 Assign)
    assign_to_l3                                         TEXT                          , -- [8] Assign to L3
    assign_to_personal                                   TEXT                          , -- [9] Assign To Personal
    assign_personal_l2_l2_assign                         TEXT                          , -- [10] Assign Personal L2(L2 Assign)
    attachment_docman_create_ticket_attachmentdocman     TEXT                          , -- [11] Attachment Docman(Create Ticket_attachmentdocman)
    createtime_l1_assign                                 TEXT                          , -- [12] CreateTime(l1 assign)
    assign_personal_l1_assign                            TEXT                          , -- [13] Assign Personal(L1 Assign)
    submittime_l1_assign                                 TEXT                          , -- [14] SubmitTime(l1 assign)
    createtime_l1_handle                                 TEXT                          , -- [15] CreateTime(l1 handle)
    operator_l1_handle                                   TEXT                          , -- [16] Operator(l1 handle)
    submittime_l1_handle                                 TEXT                          , -- [17] SubmitTime(l1 handle)
    createtime_l3_handle                                 TEXT                          , -- [18] CreateTime(l3 handle)
    operator_l3_handle                                   TEXT                          , -- [19] Operator(l3 handle)
    submittime_l3_handle                                 TEXT                          , -- [20] SubmitTime(l3 handle)
    createtime_l2_assign                                 TEXT                          , -- [21] CreateTime(l2 assign)
    assign_personal_l2_assign                            TEXT                          , -- [22] Assign Personal(L2 Assign)
    submittime_l2_assign                                 TEXT                          , -- [23] SubmitTime(l2 assign)
    createtime_confirm_close                             TEXT                          , -- [24] CreateTime(confirm close)
    operator_confirm_close                               TEXT                          , -- [25] Operator(confirm close)
    submittime_confirm_close                             TEXT                          , -- [26] SubmitTime(confirm close)
    createtime_confirm_ticket                            TEXT                          , -- [27] CreateTime(confirm ticket)
    operator_confirm_ticket                              TEXT                          , -- [28] Operator(confirm ticket)
    submittime_confirm_ticket                            TEXT                          , -- [29] SubmitTime(confirm ticket)
    business_status                                      TEXT                          , -- [30] Business Status
    cancel_reason                                        TEXT                          , -- [31] Cancel Reason
    cause                                                TEXT                          , -- [32] Cause
    does_smartcare_suggestion_helpful                    TEXT                          , -- [33] Does Smartcare Suggestion helpful?
    please_give_feedback_to_smartcare_l2_assign          TEXT                          , -- [34] Please give feedback to Smartcare(L2 Assign)
    cch_suggestion_l1_assign_cch_suggestion              TEXT                          , -- [35] CCH Suggestion(L1 Assign_cch_suggestion)
    cch_suggestion_2_l1_assign                           TEXT                          , -- [36] cch_suggestion_2(L1 Assign)
    cch_suggestion_3_l1_assign                           TEXT                          , -- [37] cch_suggestion_3(L1 Assign)
    cell_id_l2_assign_cell_id                            TEXT                          , -- [38] Cell ID(L2 Assign_cell_id)
    closed_timestamp_create_ticket                       TEXT                          , -- [39] Closed Timestamp(Create Ticket)
    complain_source_create_ticket                        TEXT                          , -- [40] Complain Source(Create Ticket)
    complain_submitter_create_ticket                     TEXT                          , -- [41] Complain Submitter(Create Ticket)
    complainer_name_create_ticket                        TEXT                          , -- [42] Complainer Name(Create Ticket)
    country_roaming_create_ticket                        TEXT                          , -- [43] Country (Roaming)(Create Ticket)
    create_time                                          TIMESTAMP WITH TIME ZONE      , -- [44] Create Time
    creator                                              TEXT                          , -- [45] Creator
    assign_to_l1_assign                                  TEXT                          , -- [46] Assign to(L1 Assign)
    current_phase                                        TEXT                          , -- [47] Current Phase
    current_phase_name                                   TEXT                          , -- [48] Current Phase Name
    customer_create_ticket                               TEXT                          , -- [49] Customer(Create Ticket)
    company_create_ticket                                TEXT                          , -- [50] Company(Create Ticket)
    customer_interaction_date_create_ticket              TEXT                          , -- [51] Customer Interaction Date(Create Ticket)
    customer_msisdn_create_ticket_customer_msisdn        TEXT                          , -- [52] Customer MSISDN(Create Ticket_customer_msisdn)
    contact_create_ticket                                TEXT                          , -- [53] Contact(Create Ticket)
    customer_region_create_ticket_customer_region        TEXT                          , -- [54] Customer Region(Create Ticket_customer_region)
    customer_subtype_create_ticket_customer_subtype      TEXT                          , -- [55] Customer SubType(Create Ticket_customer_subtype)
    customer_type_create_ticket_customer_type            TEXT                          , -- [56] Customer Type(Create Ticket_customer_type)
    demarcation_feedback_timestamp                       TEXT                          , -- [57] demarcation_feedback_timestamp
    l1_assign                                            TEXT                          , -- [58] (L1 Assign)
    description                                          TEXT                          , -- [59] Description
    description_fault_sumptomps_create_ticket_description_fault_symptomps TEXT                          , -- [60] Description Fault Sumptomps(Create Ticket_description__fault_symptomps)
    details_area_location_create_ticket_details_area_location TEXT                          , -- [61] Details Area Location(Create Ticket_details_area__location)
    end_time                                             TEXT                          , -- [62] End Time
    escalate                                             TEXT                          , -- [63] Escalate
    l1_assign_escalate_timestamp                         TEXT                          , -- [64] (L1 Assign_escalate_timestamp)
    exempt                                               TEXT                          , -- [65] Exempt
    exempt_reason                                        TEXT                          , -- [66] Exempt Reason
    cell_id_l2_assign                                    TEXT                          , -- [67] Cell ID(L2 Assign)
    fault_cell_or_site2_l1_assign                        TEXT                          , -- [68] fault_cell_or_site2(L1 Assign)
    fault_cell_or_site3_l1_assign                        TEXT                          , -- [69] fault_cell_or_site3(L1 Assign)
    cch_hold_ticket                                      TEXT                          , -- [70] CCH Hold Ticket
    gtx_complain_id_create_ticket_gtx_complain_id        TEXT                          , -- [71] GTX Complain ID(Create Ticket_gtx_complain_id)
    region_create_ticket                                 TEXT                          , -- [72] Region(Create Ticket)
    country_name                                         TEXT                          , -- [73] Country Name
    country_operator                                     TEXT                          , -- [74] Country Operator
    kabupaten_kota_create_ticket                         TEXT                          , -- [75] Kabupaten/Kota(Create Ticket)
    kecamatan_create_ticket                              TEXT                          , -- [76] kecamatan(Create Ticket)
    desa_kelurahan_create_ticket                         TEXT                          , -- [77] Desa/Kelurahan(Create Ticket)
    last_update_time                                     TEXT                          , -- [78] Last Update Time
    last_updater                                         TEXT                          , -- [79] Last Updater
    latitude_l2_assign                                   NUMERIC(12, 8)                , -- [80] Latitude(L2 Assign)
    longitude_l2_assign                                  NUMERIC(12, 8)                , -- [81] Longitude(L2 Assign)
    manual_create_create_ticket                          TEXT                          , -- [82] Manual Create(Create Ticket)
    is_the_complain_a_roaming_type_create_ticket         TEXT                          , -- [83] Is the complain a roaming type?(Create Ticket)
    module_name                                          TEXT                          , -- [84] Module Name
    nsd_attachment_1                                     TEXT                          , -- [85] NSD Attachment 1
    nsd_attachment_1_name                                TEXT                          , -- [86] nsd attachment 1 name
    ola_ctp                                              TEXT                          , -- [87] ola_ctp
    ola_nsh                                              TEXT                          , -- [88] OLA NSH
    ola_regional_create_ticket                           TEXT                          , -- [89] OLA Regional(Create Ticket)
    ola_status                                           TEXT                          , -- [90] Ola Status
    ola_target_time                                      TEXT                          , -- [91] Ola Target Time
    operation_mode                                       TEXT                          , -- [92] Operation Mode
    operation_mode_confirm_close_operation_mode_confirm  TEXT                          , -- [93] Operation Mode(Confirm Close_operation_mode_confirm)
    operation_mode_l1_assign_operation_mode_l1           TEXT                          , -- [94] Operation Mode(L1 Assign_operation_mode_l1)
    operation_mode_l2_assign_operation_mode_l2           TEXT                          , -- [95] Operation Mode(L2 Assign_operation_mode_l2)
    operation_mode_l3_assign_operation_mode_l3           TEXT                          , -- [96] Operation Mode(L3 Assign_operation_mode_l3)
    operator_roaming_create_ticket                       TEXT                          , -- [97] Operator (Roaming)(Create Ticket)
    order_status                                         TEXT                          , -- [98] Order Status
    order_seq                                            TEXT                          , -- [99] Order Seq
    parent_app_name                                      TEXT                          , -- [100] Parent App Name
    parent_module_name                                   TEXT                          , -- [101] Parent Module Name
    parent_order_id                                      TEXT                          , -- [102] Parent Order Id
    parent_process_key                                   TEXT                          , -- [103] Parent Process Key
    parent_process_name                                  TEXT                          , -- [104] Parent Process Name
    parent_ticket_id                                     TEXT                          , -- [105] Parent Ticket Id
    pengaduan_create_ticket_pengaduan                    TEXT                          , -- [106] Pengaduan(Create Ticket_pengaduan)
    priority_l2_assign                                   TEXT                          , -- [107] Priority(L2 Assign)
    problem_analysis                                     TEXT                          , -- [108] Problem Analysis
    problem_start_time_create_ticket_problem_start_time  TEXT                          , -- [109] Problem Start Time(Create Ticket_problem_start_time)
    process_key                                          TEXT                          , -- [110] Process Key
    process_name                                         TEXT                          , -- [111] Process Name
    process_type                                         TEXT                          , -- [112] Process Type
    provinsi_create_ticket_provinsi                      TEXT                          , -- [113] Provinsi(Create Ticket_provinsi)
    resolution_l2_assign                                 TEXT                          , -- [114] Resolution(L2 Assign)
    tier_1_create_ticket                                 TEXT                          , -- [115] Tier 1(Create Ticket)
    tier_2_create_ticket                                 TEXT                          , -- [116] Tier 2(Create Ticket)
    tier_3_create_ticket                                 TEXT                          , -- [117] Tier 3(Create Ticket)
    reassign_number_l2_assign                            TEXT                          , -- [118] reassign_number(L2 Assign)
    remark_confirm_close                                 TEXT                          , -- [119] Remark(Confirm Close)
    reopen_number_confirm_close                          INTEGER                       , -- [120] Reopen Number(Confirm Close)
    resolution                                           TEXT                          , -- [121] Resolution
    resolution_attachment_1                              TEXT                          , -- [122] Resolution Attachment 1
    resolution_attachment_1_name                         TEXT                          , -- [123] Resolution Attachment 1 Name
    resolution_attachment_2                              TEXT                          , -- [124] Resolution Attachment 2
    resolution_attachment_3                              TEXT                          , -- [125] Resolution Attachment 3
    resolution_categorization_tier_1                     TEXT                          , -- [126] Resolution Categorization Tier 1
    resolution_categorization_tier_2                     TEXT                          , -- [127] Resolution Categorization Tier 2
    resolution_categorization_tier_3                     TEXT                          , -- [128] Resolution Categorization Tier 3
    l1_assign_resolved_timestamp                         TEXT                          , -- [129] (L1 Assign_resolved_timestamp)
    resolution_categorization_tier_2_l1_assign           TEXT                          , -- [130] Resolution Categorization Tier 2(L1 Assign)
    role_project_name                                    TEXT                          , -- [131] Role project name
    root_cause_tier_1_l1_assign                          TEXT                          , -- [132] Root Cause Tier 1(L1 Assign)
    root_caused_category_l2_assign                       TEXT                          , -- [133] Root Caused Category(L2 Assign)
    root_caused_detail                                   TEXT                          , -- [134] Root Caused Detail
    root_caused_others                                   TEXT                          , -- [135] Root Caused Others
    root_caused_tier_1_l2_assign                         TEXT                          , -- [136] Root Caused Tier 1(L2 Assign)
    root_caused_tier_2_l2_assign                         TEXT                          , -- [137] Root Caused Tier 2(L2 Assign)
    root_caused_tier_3_l2_assign                         TEXT                          , -- [138] Root Caused Tier 3(L2 Assign)
    root_caused_tier_4_l2_assign                         TEXT                          , -- [139] Root Caused Tier 4(L2 Assign)
    root_caused_tier_5_l2_assign                         TEXT                          , -- [140] Root Caused Tier 5(L2 Assign)
    root_caused_tier_6_l2_assign                         TEXT                          , -- [141] Root Caused Tier 6(L2 Assign)
    root_caused_tier_7_l2_assign                         TEXT                          , -- [142] Root Caused Tier 7(L2 Assign)
    root_caused_tier_8_l2_assign                         TEXT                          , -- [143] Root Caused Tier 8(L2 Assign)
    service_type_create_ticket                           TEXT                          , -- [144] Service Type(Create Ticket)
    tier_1_create_ticket_service_categorization_tier_1   TEXT                          , -- [145] Tier 1(Create Ticket_service_categorization_tier_1)
    tier_2_create_ticket_service_categorization_tier_2   TEXT                          , -- [146] Tier 2(Create Ticket_service_categorization_tier_2)
    tier_3_create_ticket_service_categorization_tier_3   TEXT                          , -- [147] Tier 3(Create Ticket_service_categorization_tier_3)
    tier_4_create_ticket                                 TEXT                          , -- [148] Tier 4(Create Ticket)
    service_id_create_ticket_service_id                  TEXT                          , -- [149] Service ID(Create Ticket_service_id)
    site_id_l2_assign                                    TEXT                          , -- [150] Site ID(L2 Assign)
    site_id2_l1_assign                                   TEXT                          , -- [151] site_id2(L1 Assign)
    site_id3_l1_assign                                   TEXT                          , -- [152] site_id3(L1 Assign)
    l1_assign_sla                                        TEXT                          , -- [153] (L1 Assign_sla)
    sla_paused                                           TEXT                          , -- [154] Sla Paused
    sla_pausing                                          TEXT                          , -- [155] Sla Pausing
    sla_status                                           TEXT                          , -- [156] Sla Status
    sla_suspend_duration                                 TEXT                          , -- [157] Sla Suspend Duration
    sla_suspend_reason                                   TEXT                          , -- [158] Sla Suspend Reason
    sla_suspend_resume_time                              TEXT                          , -- [159] Sla Suspend Resume Time
    sla_suspend_status                                   TEXT                          , -- [160] Sla Suspend Status
    sla_target_time                                      TEXT                          , -- [161] Sla Target Time
    status_reason                                        TEXT                          , -- [162] Status Reason
    submitter_create_ticket_submitter                    TEXT                          , -- [163] Submitter(Create Ticket_submitter)
    subscription_brand_create_ticket_subscription_brand  TEXT                          , -- [164] Subscription Brand(Create Ticket_subscription_brand)
    loyalty_create_ticket                                TEXT                          , -- [165] Loyalty(Create Ticket)
    subscription_status_create_ticket_subscription_status TEXT                          , -- [166] Subscription Status(Create Ticket_subscription_status)
    subscription_sub_status_create_ticket_subscription_substatus TEXT                          , -- [167] Subscription Sub Status(Create Ticket_subscription_substatus)
    subscription_type_create_ticket_subscription_type    TEXT                          , -- [168] Subscription Type(Create Ticket_subscription_type)
    summary_create_ticket                                TEXT                          , -- [169] Summary(Create Ticket)
    activity_notes                                       TEXT                          , -- [170] Activity Notes
    ticket_id                                            VARCHAR(64)                   , -- [171] Ticket Id
    time_range_l1_assign_time_range                      TEXT                          , -- [172] Time Range(L1 Assign_time_range)
    timeframe_pelanggan_create_ticket                    TEXT                          , -- [173] Timeframe Pelanggan(Create Ticket)
    title                                                TEXT                          , -- [174] Title
    transactionid_create_ticket                          TEXT                          , -- [175] transactionId(Create Ticket)
    createtime_createtask                                TEXT                          , -- [176] CreateTime(CreateTask)
    operator_createtask                                  TEXT                          , -- [177] Operator(CreateTask)
    submittime_createtask                                TEXT                          , -- [178] SubmitTime(CreateTask)
    createtime_processtask                               TEXT                          , -- [179] CreateTime(ProcessTask)
    operator_processtask                                 TEXT                          , -- [180] Operator(ProcessTask)
    submittime_processtask                               TEXT                          , -- [181] SubmitTime(ProcessTask)
    createtime_confirmtask                               TEXT                          , -- [182] CreateTime(ConfirmTask)
    operator_confirmtask                                 TEXT                          , -- [183] Operator(ConfirmTask)
    submittime_confirmtask                               TEXT                          , -- [184] SubmitTime(ConfirmTask)
    type_handset                                         TEXT                          , -- [185] Type Handset
    type_jaringan                                        TEXT                          , -- [186] Type Jaringan
    user_id_submitter_create_ticket_user_id_submitter    TEXT                          , -- [187] User ID Submitter(Create Ticket_user_id_submitter)
    vendor_ticket_number                                 TEXT                          , -- [188] Vendor Ticket Number
    rc_tier_1_nsh                                        TEXT                          , -- [189] RC Tier 1 NSH
    rc_tier_2_nsh                                        TEXT                          , -- [190] RC Tier 2 NSH
    rc_tier_nsh                                          TEXT                          , -- [191] RC Tier NSH
    rc_tier_4_nsh                                        TEXT                          , -- [192] RC Tier 4 NSH
    rc_tier_5_nsh                                        TEXT                          , -- [193] RC Tier 5 NSH
    rc_tier_6_nsh                                        TEXT                          , -- [194] RC Tier 6 NSH
    rc_tier_7_nsh                                        TEXT                          , -- [195] RC Tier 7 NSH
    rc_tier_8_nsh                                        TEXT                          , -- [196] RC Tier 8 NSH
    site_id_nsh                                          TEXT                          , -- [197] Site ID NSH
    rc_category_nsh                                      TEXT                          , -- [198] RC Category NSH
    root_caused_detail_nsh                               TEXT                          , -- [199] Root Caused Detail NSH
    resolution_categorization_tier_1_l1_assign           TEXT                          , -- [200] Resolution Categorization Tier 1(L1 Assign)
    kode_post_c_create_ticket_kode_post_c                TEXT                          , -- [201] Kode Post C(Create Ticket_kode_post_c)
    resolution_categorization_tier_3_l1_assign           TEXT                          , -- [202] Resolution Categorization Tier 3(L1 Assign)
    rc_detail_cch                                        TEXT                          , -- [203] RC Detail CCH
    rc_category_cch                                      TEXT                          , -- [204] RC Category CCH
    cch_automation_case                                  TEXT                          , -- [205] CCH Automation Case
    problem_analysis_nsh                                 TEXT                          , -- [206] Problem Analysis NSH
    site_id1_l1_assign                                   TEXT                          , -- [207] site_id1(L1 Assign)
    fault_cell_or_site                                   TEXT                          , -- [208] Fault_cell_or_site
    created_at                                           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at                                           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indeks Performa untuk Kolom yang Sering Difilter / Dicari
CREATE INDEX IF NOT EXISTS idx_inap_create_time ON "SQA_SUMBAGUT".inap_ticketing_customer_complain(create_time);
CREATE INDEX IF NOT EXISTS idx_inap_city ON "SQA_SUMBAGUT".inap_ticketing_customer_complain(kabupaten_kota_create_ticket);
CREATE INDEX IF NOT EXISTS idx_inap_site1 ON "SQA_SUMBAGUT".inap_ticketing_customer_complain(site_id1_l1_assign);
CREATE INDEX IF NOT EXISTS idx_inap_assign_l2 ON "SQA_SUMBAGUT".inap_ticketing_customer_complain(assign_to_l2_l2_assign);
CREATE INDEX IF NOT EXISTS idx_inap_business_status ON "SQA_SUMBAGUT".inap_ticketing_customer_complain(business_status);
CREATE INDEX IF NOT EXISTS idx_inap_current_phase ON "SQA_SUMBAGUT".inap_ticketing_customer_complain(current_phase_name);

-- =============================================================================
-- TABEL 2: RIWAYAT PENGIRIMAN & DEDUPLIKASI (Pengganti sent_tickets.json)
-- Berelasi langsung (Foreign Key) dengan tabel master inap_ticketing_customer_complain
-- =============================================================================
CREATE TABLE IF NOT EXISTS "SQA_SUMBAGUT".inap_sent_tickets_history (
    id                                                  BIGSERIAL PRIMARY KEY,
    order_id                                            VARCHAR(64) NOT NULL REFERENCES "SQA_SUMBAGUT".inap_ticketing_customer_complain(order_id) ON DELETE CASCADE,
    dispatch_type                                       VARCHAR(32) NOT NULL, -- INITIAL, REOPEN, REASSIGNMENT, SITE_VISIT, REMINDER
    sent_at                                             TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    sent_date                                           DATE NOT NULL,        -- Tanggal WIB (YYYY-MM-DD) untuk cek duplikat harian
    target_whatsapp_group_jid                           VARCHAR(128),
    source_request_jid                                  VARCHAR(128),
    assigned_pic                                        VARCHAR(128),
    target_destination                                  VARCHAR(128),         -- SQA, NOP PEMATANG SIANTAR, SITE VISIT, dll.
    sla_status                                          VARCHAR(32),          -- IN SLA, OUT SLA
    business_status                                     VARCHAR(64),
    reopen_count                                        INTEGER DEFAULT 0,
    is_repetitive                                       BOOLEAN DEFAULT FALSE,
    sent_to_site_visit                                  BOOLEAN DEFAULT FALSE,
    site_visit_sent_at                                  TIMESTAMP WITH TIME ZONE,
    site_visit_target_jid                               VARCHAR(128),
    escalated_from_previous                             VARCHAR(128),
    created_at                                          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indeks Relasi & Pencarian Cepat Riwayat Pengiriman
CREATE INDEX IF NOT EXISTS idx_inap_sent_order_id ON "SQA_SUMBAGUT".inap_sent_tickets_history(order_id);
CREATE INDEX IF NOT EXISTS idx_inap_sent_date ON "SQA_SUMBAGUT".inap_sent_tickets_history(sent_date);
CREATE INDEX IF NOT EXISTS idx_inap_sent_target ON "SQA_SUMBAGUT".inap_sent_tickets_history(target_destination);
