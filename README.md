# bookend-ai-solution
이어드림스쿨 Final 산업 특화 연계 프로젝트


erDiagram
    users ||--o{ records : "기록한다"
    users ||--o{ materials : "소유"
    users ||--o{ essays : "쓴다"
    users ||--o{ suggestions : "받는다"
    users ||--o{ ai_requests : "요청"

    records ||--o{ qna_messages : "문답"
    daily_questions |o--o{ qna_messages : "첫 질문"
    records ||--o| materials : "추출"
    ai_requests |o--o| records : "최근 분석 요청"

    materials ||--o{ material_topics : ""
    topics ||--o{ material_topics : ""

    essays ||--o{ essay_materials : ""
    materials ||--o{ essay_materials : "사용"
    essays ||--o{ essay_versions : "버전"
    essay_versions |o--o{ essay_versions : "다시 만들기 바탕"
    ai_requests |o--o{ essay_versions : "생성"

    topics ||--o{ suggestions : "주제"
    suggestions ||--o{ suggestion_materials : ""
    materials ||--o{ suggestion_materials : "사용할 소재"
    suggestions |o--o{ essays : "제안에서 시작"

    users {
        uuid id PK
        timestamptz created_at
        timestamptz ai_consent_at
        timestamptz data_cleared_at
        timestamptz last_seen_at
    }
    records {
        uuid id PK
        uuid user_id FK
        enum type "free | qna"
        text title
        text body
        enum status "draft | saved"
        enum analysis_status
        bigint latest_analysis_request_id FK
        timestamptz saved_at
        timestamptz updated_at
    }
    qna_messages {
        uuid id PK
        uuid record_id FK
        int seq
        text question
        enum question_source "daily | followup"
        uuid daily_question_id FK
        text answer
        bool is_skipped
    }
    daily_questions {
        uuid id PK
        date question_date UK
        int seq UK
        text question
    }
    materials {
        uuid id PK
        uuid user_id FK
        uuid record_id FK, UK
        text title
        text summary
        text evidence
        text_array keywords
        enum origin "ai | manual"
        timestamptz confirmed_at
        timestamptz user_edited_at
        timestamptz deleted_at
    }
    topics {
        smallint id PK
        text name UK
        smallint sort_order
    }
    material_topics {
        uuid material_id PK, FK
        smallint topic_id PK, FK
    }
    essays {
        uuid id PK
        uuid user_id FK
        uuid suggestion_id FK
        enum method "direct | ai"
        enum status "draft | saved"
        text title
        text draft_body
        text direction
        timestamptz updated_at
    }
    essay_materials {
        uuid essay_id PK, FK
        uuid material_id PK, FK
        int seq
    }
    essay_versions {
        uuid id PK
        uuid essay_id FK, UK
        int version_no UK
        enum kind
        text title
        text body
        int char_count
        text style
        enum length "short | long"
        int regen_count
        uuid based_on_version_id FK
        bigint ai_request_id FK
        jsonb generation_input
        uuid save_token UK
    }
    suggestions {
        uuid id PK
        uuid user_id FK, UK
        smallint topic_id FK, UK
        enum status
        text title
        text direction
        text reason
        text basis_hash
        timestamptz computed_at
    }
    suggestion_materials {
        uuid suggestion_id PK, FK
        uuid material_id PK, FK
        int seq
    }
    ai_requests {
        bigint id PK
        uuid user_id FK
        enum kind
        enum target_type
        uuid target_id
        enum status
        jsonb result
        timestamptz started_at
        timestamptz finished_at
        text failure_reason
    }
