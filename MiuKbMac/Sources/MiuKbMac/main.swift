import Foundation
import SwiftUI

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct APIClient {
    let baseURL = URL(string: "http://127.0.0.1:17322")!
    let token: String

    static func fromDefaultToken() -> APIClient {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/miu-kb/token")
        let token = (try? String(contentsOf: path, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return APIClient(token: token)
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await request(path, method: "GET", query: query, body: Optional<Data>.none)
    }

    func post<T: Decodable, Body: Encodable>(_ path: String, body: Body? = nil) async throws -> T {
        let data = body.map { try! JSONEncoder().encode($0) }
        return try await request(path, method: "POST", body: data)
    }

    func patch<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        try await request(path, method: "PATCH", body: JSONEncoder().encode(body))
    }

    func put<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        try await request(path, method: "PUT", body: JSONEncoder().encode(body))
    }

    private func request<T: Decodable>(_ path: String, method: String, query: [String: String] = [:], body: Data?) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/" + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        queryItems.append(URLQueryItem(name: "token", value: token))
        components.queryItems = queryItems
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).displayMessage)
                ?? HTTPURLResponse.localizedString(forStatusCode: status)
            throw APIError(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct ErrorResponse: Decodable {
    var error: String?
    var detail: String?
    var message: String?
    var displayMessage: String { message ?? detail ?? error ?? "请求失败" }
}

struct EmptyBody: Encodable {}

struct CandidateIdsBody: Encodable {
    var candidateIds: [String]
    var source: String

    enum CodingKeys: String, CodingKey {
        case candidateIds = "candidate_ids"
        case source
    }
}

struct Overview: Decodable {
    var generatedAt: String?
    var health: String
    var review: ReviewSummary
    var ai: AiOverview?
    var memories: MemoriesOverview
    var storage: StorageSummary
    var last7Days: [OverviewDay]?
    var recentCandidates: [OverviewCandidate]?
}

struct ReviewSummary: Decodable {
    var counts: [String: Int]
    var actions: [String: Int]?
    var types: [String: Int]?
    var total: Int
    var pending: Int
    var approvalRate: Double
}

struct AiOverview: Decodable {
    var queue: [String: Int]
    var turns: [String: Int]
}

struct OverviewDay: Decodable, Identifiable {
    var day: String
    var created: Int
    var approved: Int
    var rejected: Int
    var merged: Int
    var id: String { day }
}

struct OverviewCandidate: Decodable, Identifiable {
    var id: String
    var status: String
    var memoryAction: String?
    var content: String
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, status, content
        case memoryAction = "memory_action"
        case createdAt = "created_at"
    }
}

struct MemoriesOverview: Decodable {
    var counts: MemoryCounts
}

struct MemoryCounts: Decodable {
    var active: Int
    var deleted: Int
    var all: Int
    var types: [String: Int]
    var scopes: [String: Int]
}

struct StorageSummary: Decodable {
    var totalLabel: String
}

struct CandidateState: Decodable {
    var candidates: [Candidate]
    var counts: [String: Int]
    var pagination: Pagination
}

struct MemoryState: Decodable {
    var memories: [MemoryItem]
    var counts: MemoryCounts
    var pagination: Pagination
}

struct Pagination: Decodable {
    var page: Int
    var pageSize: Int
    var total: Int
    var totalPages: Int
}

struct Candidate: Decodable, Identifiable {
    var id: String
    var status: String
    var type: String
    var scope: String
    var content: String
    var tags: [String]
    var category: String?
    var confidence: Double?
    var memoryAction: String
    var createdAt: String?
    var projectPath: String?
    var cwd: String?
    var targetCurrentStatus: String?
    var targetResolutionMessage: String?

    enum CodingKeys: String, CodingKey {
        case id, status, type, scope, content, tags, category, confidence, cwd
        case memoryAction = "memory_action"
        case createdAt = "created_at"
        case projectPath = "project_path"
        case targetCurrentStatus = "target_current_status"
        case targetResolutionMessage = "target_resolution_message"
    }
}

struct CandidatePayload: Encodable {
    var content: String
    var type: String
    var scope: String
    var tags: String
    var category: String?
}

struct CandidateEnvelope: Decodable {
    var candidate: Candidate?
    var output: String?
}

struct GenericResponse: Decodable {
    var ok: Bool?
    var message: String?
    var output: String?
    var memoryId: String?
    var alreadyGone: Bool?
    var deletedCount: Int?

    enum CodingKeys: String, CodingKey {
        case ok, message, output, deletedCount
        case memoryId = "memory_id"
        case alreadyGone
    }
}

struct BootstrapResponse: Decodable {
    var ok: Bool
    var paths: [String: String]?
}

struct MemoryItem: Decodable, Identifiable {
    var id: String
    var content: String
    var type: String
    var scope: String
    var displayScope: String?
    var tags: [String]
    var category: String?
    var projectId: String?
    var updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, content, type, scope, tags, category
        case displayScope = "display_scope"
        case projectId = "project_id"
        case updatedAt = "updated_at"
    }
}

struct TraceState: Decodable {
    var traces: [RecallTrace]
    var pagination: Pagination
}

struct RecallTrace: Decodable, Identifiable {
    var id: String
    var cwd: String?
    var promptExcerpt: String?
    var query: String?
    var status: String
    var rules: [TraceItem]
    var memories: [TraceItem]
    var injectedChars: Int
    var approxTokens: Int
    var error: String?
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, cwd, query, status, rules, memories, error
        case promptExcerpt = "prompt_excerpt"
        case injectedChars = "injected_chars"
        case approxTokens = "approx_tokens"
        case createdAt = "created_at"
    }
}

struct TraceItem: Decodable, Identifiable {
    var id: String
    var type: String?
    var scope: String?
    var rank: Double?
    var reason: String?
    var content: String
}

struct AiQueueState: Decodable {
    var turns: [QueueTurn]
    var counts: [String: Int]
    var pagination: Pagination
}

struct QueueTurn: Decodable, Identifiable {
    var id: String
    var cwd: String?
    var status: String
    var error: String?
    var createdAt: String?
    var processedAt: String?
    var candidateCount: Int
    var pendingCandidateCount: Int
    var approvedCandidateCount: Int
    var rejectedCandidateCount: Int
    var taskType: String?
    var reviewCandidateCount: Int?
    var reviewCandidates: [QueueReviewCandidate]

    enum CodingKeys: String, CodingKey {
        case id, cwd, status, error
        case createdAt = "created_at"
        case processedAt = "processed_at"
        case candidateCount = "candidate_count"
        case pendingCandidateCount = "pending_candidate_count"
        case approvedCandidateCount = "approved_candidate_count"
        case rejectedCandidateCount = "rejected_candidate_count"
        case taskType = "task_type"
        case reviewCandidateCount = "review_candidate_count"
        case reviewCandidates = "review_candidates"
    }
}

struct QueueReviewCandidate: Decodable, Identifiable {
    var id: String
    var status: String
    var type: String?
    var scope: String?
    var content: String?
    var memoryAction: String?
    var approvedMemoryId: String?
    var aiAction: String?
    var aiReason: String?
    var aiConfidence: Double?
    var reviewedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, status, type, scope, content
        case memoryAction = "memory_action"
        case approvedMemoryId = "approved_memory_id"
        case aiAction = "ai_action"
        case aiReason = "ai_reason"
        case aiConfidence = "ai_confidence"
        case reviewedAt = "reviewed_at"
    }
}

struct SelfCheckState: Decodable {
    var health: String
    var generatedAt: String?
    var checks: [SelfCheckItem]
    var logs: [LogItem]
}

struct SelfCheckItem: Decodable, Identifiable {
    var id: String
    var title: String
    var status: String
    var detail: String?
    var hint: String?
}

struct LogItem: Decodable, Identifiable {
    var key: String
    var label: String
    var path: String
    var exists: Bool
    var tail: String?
    var id: String { key }
}

struct ModelCheckState: Decodable {
    var generatedAt: String?
    var ok: Bool
    var model: String
    var reasoningEffort: String?
    var detail: String?
}

struct AiSettingsState: Decodable {
    var settings: AiSettings
    var defaults: AiSettings
    var path: String
    var updatedAt: String?
    var modelOptions: [String]
}

struct AiSettingsEnvelope: Encodable {
    var settings: AiSettings
}

struct AiSettings: Codable {
    var model: String
    var reasoningEffort: String
    var maxCandidatesPerTurn: Int
    var duplicateThreshold: Double
    var topicDuplicateThreshold: Double
    var relatedContextLimit: Int
    var relatedContextMinScore: Double
    var relatedContextItemChars: Int
    var relatedContextTotalChars: Int
    var llmTimeoutMs: Int
}

struct PromptState: Decodable {
    var prompt: String
    var defaultPrompt: String
    var path: String
    var usingDefault: Bool
    var updatedAt: String?
}

struct PromptEnvelope: Encodable {
    var prompt: String
}

struct LifecycleState: Decodable {
    var events: [LifecycleEvent]
    var candidates: [LifecycleCandidate]
}

struct LifecycleEvent: Decodable, Identifiable {
    var id: String
    var action: String
    var reason: String?
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, action, reason
        case createdAt = "created_at"
    }
}

struct LifecycleCandidate: Decodable, Identifiable {
    var id: String
    var status: String
    var scope: String
    var branchName: String?

    enum CodingKeys: String, CodingKey {
        case id, status, scope
        case branchName = "branch_name"
    }
}

@MainActor
final class AppModel: ObservableObject {
    enum Section: String, CaseIterable, Identifiable {
        case onboarding = "首次使用"
        case overview = "概览"
        case review = "审核台"
        case knowledge = "知识库"
        case trace = "引用解释"
        case ai = "AI 队列"
        case selfCheck = "自检"
        case settings = "设置"
        var id: String { rawValue }
    }

    static let onboardingHiddenKey = "miuKbOnboardingHidden"
    static let darkModeKey = "miuKbDarkMode"
    var api = APIClient.fromDefaultToken()
    @Published var section: Section
    @Published var onboardingHidden: Bool
    @Published var darkMode: Bool
    @Published var overview: Overview?
    @Published var candidates: [Candidate] = []
    @Published var memories: [MemoryItem] = []
    @Published var traces: [RecallTrace] = []
    @Published var queueTurns: [QueueTurn] = []
    @Published var selfCheck: SelfCheckState?
    @Published var modelCheck: ModelCheckState?
    @Published var aiSettings: AiSettingsState?
    @Published var promptState: PromptState?
    @Published var reviewPromptState: PromptState?
    @Published var lifecycle: LifecycleState?
    @Published var bootstrapPaths: [String: String] = [:]
    @Published var bootstrapOutput = ""
    @Published var isBootstrapping = false
    @Published var candidateCounts: [String: Int] = [:]
    @Published var memoryCounts: MemoryCounts?
    @Published var filter = "pending"
    @Published var reviewQuery = ""
    @Published var reviewPage = 1
    @Published var reviewPageSize = 20
    @Published var reviewPagination = Pagination(page: 1, pageSize: 20, total: 0, totalPages: 1)
    @Published var memoryType = "all"
    @Published var memoryScope = "all"
    @Published var memoryStatus = "active"
    @Published var memoryQuery = ""
    @Published var memoryPage = 1
    @Published var memoryPageSize = 20
    @Published var memoryPagination = Pagination(page: 1, pageSize: 20, total: 0, totalPages: 1)
    @Published var tracePage = 1
    @Published var tracePageSize = 20
    @Published var tracePagination = Pagination(page: 1, pageSize: 20, total: 0, totalPages: 1)
    @Published var aiStatus = "all"
    @Published var aiQuery = ""
    @Published var aiPage = 1
    @Published var aiPageSize = 20
    @Published var aiCounts: [String: Int] = [:]
    @Published var aiPagination = Pagination(page: 1, pageSize: 20, total: 0, totalPages: 1)
    @Published var isLoading = false
    @Published var showLoadingIndicator = false
    @Published var error: String?
    private var loadingTicket = 0

    init() {
        let hidden = UserDefaults.standard.bool(forKey: Self.onboardingHiddenKey)
        onboardingHidden = hidden
        darkMode = UserDefaults.standard.bool(forKey: Self.darkModeKey)
        section = hidden ? .overview : .onboarding
    }

    var visibleSections: [Section] {
        Section.allCases.filter { $0 != .onboarding || !onboardingHidden }
    }

    func launch() async {
        if api.token.isEmpty {
            showOnboarding("未找到本机 token，请先完成初始化。")
        }
        await refresh()
    }

    func refresh() async {
        let ticket = beginLoading()
        error = nil
        do {
            switch section {
            case .onboarding:
                selfCheck = try await api.get("api/self-check")
            case .overview:
                overview = try await api.get("api/overview")
            case .review:
                let state: CandidateState = try await api.get("api/state", query: [
                    "status": filter,
                    "page": "\(reviewPage)",
                    "pageSize": "\(reviewPageSize)",
                    "q": reviewQuery,
                ])
                candidates = state.candidates
                candidateCounts = state.counts
                reviewPagination = state.pagination
            case .knowledge:
                let state: MemoryState = try await api.get("api/memories", query: [
                    "type": memoryType,
                    "scope": memoryScope,
                    "status": memoryStatus,
                    "page": "\(memoryPage)",
                    "pageSize": "\(memoryPageSize)",
                    "q": memoryQuery,
                ])
                memories = state.memories
                memoryCounts = state.counts
                memoryPagination = state.pagination
            case .trace:
                let state: TraceState = try await api.get("api/recall-traces", query: [
                    "page": "\(tracePage)",
                    "pageSize": "\(tracePageSize)",
                ])
                traces = state.traces
                tracePagination = state.pagination
            case .ai:
                let state: AiQueueState = try await api.get("api/ai/queue", query: [
                    "status": aiStatus,
                    "page": "\(aiPage)",
                    "pageSize": "\(aiPageSize)",
                    "q": aiQuery,
                ])
                queueTurns = state.turns
                aiCounts = state.counts
                aiPagination = state.pagination
            case .selfCheck:
                selfCheck = try await api.get("api/self-check")
            case .settings:
                async let settings: AiSettingsState = api.get("api/ai/settings")
                async let prompt: PromptState = api.get("api/ai/prompt")
                async let reviewPrompt: PromptState = api.get("api/ai/review-prompt")
                aiSettings = try await settings
                promptState = try await prompt
                reviewPromptState = try await reviewPrompt
            }
        } catch {
            if shouldGuideInitialization(error) {
                showOnboarding("本地服务未连接，请在此完成首次初始化。")
            } else {
                self.error = error.localizedDescription
            }
        }
        endLoading(ticket)
    }

    func save(_ candidate: Candidate, payload: CandidatePayload) async {
        await mutate {
            let _: CandidateEnvelope = try await api.patch("api/candidates/\(candidate.id)", body: payload)
        }
    }

    func approve(_ candidate: Candidate, payload: CandidatePayload) async {
        await mutate {
            let _: CandidateEnvelope = try await api.post("api/candidates/\(candidate.id)/approve", body: payload)
        }
    }

    func reject(_ candidate: Candidate) async {
        await mutate {
            let _: CandidateEnvelope = try await api.post("api/candidates/\(candidate.id)/reject", body: EmptyBody())
        }
    }

    func deleteRejectedCandidates() async {
        reviewPage = 1
        await mutate {
            let _: GenericResponse = try await api.post("api/candidates/rejected/delete", body: EmptyBody())
        }
    }

    func enqueuePendingAiReview() async {
        let ids = candidates.filter { $0.status == "pending" }.map(\.id)
        guard !ids.isEmpty else { return }
        await mutate {
            let _: GenericResponse = try await api.post(
                "api/candidates/pending/ai-review",
                body: CandidateIdsBody(candidateIds: ids, source: "mac_app")
            )
        }
    }

    func deleteApprovedMemory(_ candidate: Candidate) async {
        await mutate {
            let _: CandidateEnvelope = try await api.post("api/candidates/\(candidate.id)/delete-memory", body: EmptyBody())
        }
    }

    func restoreDeletedCandidate(_ candidate: Candidate) async {
        await mutate {
            let _: CandidateEnvelope = try await api.post("api/candidates/\(candidate.id)/restore", body: EmptyBody())
        }
    }

    func restoreDeletedCandidates(ids: [String]) async {
        guard !ids.isEmpty else { return }
        await mutate {
            let _: GenericResponse = try await api.post(
                "api/candidates/deleted/restore",
                body: CandidateIdsBody(candidateIds: ids, source: "mac_app")
            )
        }
    }

    func purgeDeletedCandidates(ids: [String]) async {
        guard !ids.isEmpty else { return }
        await mutate {
            let _: GenericResponse = try await api.post(
                "api/candidates/deleted/purge",
                body: CandidateIdsBody(candidateIds: ids, source: "mac_app")
            )
        }
    }

    func deleteMemory(_ memory: MemoryItem) async {
        await mutate {
            let _: GenericResponse = try await api.post("api/memories/\(memory.id)/delete", body: EmptyBody())
        }
    }

    func loadLifecycle(_ memory: MemoryItem) async {
        await mutateNoRefresh {
            lifecycle = try await api.get("api/memories/\(memory.id)/lifecycle")
        }
    }

    func openLifecycleCandidate(_ id: String) async {
        lifecycle = nil
        filter = "all"
        reviewQuery = id
        reviewPage = 1
        section = .review
        await refresh()
    }

    func runWorker() async {
        await mutate {
            let _: GenericResponse = try await api.post("api/worker/run", body: EmptyBody())
        }
    }

    func runSelfCheck() async {
        await mutateNoRefresh {
            selfCheck = try await api.get("api/self-check", query: ["force": "1"])
        }
    }

    func runModelCheck() async {
        await mutateNoRefresh {
            modelCheck = try await api.post("api/self-check/model", body: EmptyBody())
        }
    }

    func saveSettings(_ settings: AiSettings) async {
        await mutate {
            aiSettings = try await api.put("api/ai/settings", body: AiSettingsEnvelope(settings: settings))
        }
    }

    func resetSettings() async {
        await mutate {
            aiSettings = try await api.post("api/ai/settings/reset", body: EmptyBody())
        }
    }

    func savePrompt(_ prompt: String) async {
        await mutate {
            promptState = try await api.put("api/ai/prompt", body: PromptEnvelope(prompt: prompt))
        }
    }

    func resetPrompt() async {
        await mutate {
            promptState = try await api.post("api/ai/prompt/reset", body: EmptyBody())
        }
    }

    func saveReviewPrompt(_ prompt: String) async {
        await mutate {
            reviewPromptState = try await api.put("api/ai/review-prompt", body: PromptEnvelope(prompt: prompt))
        }
    }

    func resetReviewPrompt() async {
        await mutate {
            reviewPromptState = try await api.post("api/ai/review-prompt/reset", body: EmptyBody())
        }
    }

    func runBranchLifecycle() async {
        await mutateNoRefresh {
            let _: GenericResponse = try await api.post("api/branches/lifecycle/run", body: EmptyBody())
        }
        await refresh()
    }

    func injectCodexIntegration() async {
        await mutateNoRefresh {
            let response: BootstrapResponse = try await api.post("api/settings/integrations/inject", body: EmptyBody())
            bootstrapPaths = response.paths ?? bootstrapPaths
            bootstrapOutput = "已注入 Codex Hook / MCP / AGENTS 配置。"
            selfCheck = try await api.get("api/self-check", query: ["force": "1"])
        }
    }

    func clearCodexIntegration() async {
        await mutateNoRefresh {
            let response: GenericResponse = try await api.post("api/settings/integrations/clear", body: EmptyBody())
            bootstrapOutput = response.message ?? "已清除 miu-kb 注入。"
            selfCheck = try await api.get("api/self-check", query: ["force": "1"])
        }
    }

    func clearStoredMemories() async {
        await mutateNoRefresh {
            let response: GenericResponse = try await api.post("api/settings/memories/clear", body: EmptyBody())
            bootstrapOutput = response.message ?? "已清除长期记忆。"
            memoryPage = 1
            overview = try? await api.get("api/overview")
        }
    }

    func uninstallMiuKb() async {
        await mutateNoRefresh {
            let response: GenericResponse = try await api.post("api/settings/uninstall", body: EmptyBody())
            bootstrapOutput = response.message ?? "已开始卸载 Miu KB。"
        }
    }

    func bootstrapFirstUse() async {
        let ticket = beginLoading()
        error = nil
        isBootstrapping = true
        bootstrapOutput = "正在初始化：检查本地服务..."
        do {
            do {
                let response: BootstrapResponse = try await api.post("api/bootstrap", body: EmptyBody())
                bootstrapPaths = response.paths ?? [:]
                bootstrapOutput = "已通过本地服务完成初始化。"
            } catch {
                if !shouldGuideInitialization(error) { throw error }
                let output = try await installBundledRuntime()
                api = APIClient.fromDefaultToken()
                bootstrapOutput = "\(output)\n正在初始化：等待本地服务启动..."
                guard await waitForServer() else {
                    throw APIError(message: "初始化脚本已执行，但本地服务仍未启动。请查看 ~/.config/miu-kb/logs/server.err.log。")
                }
                bootstrapOutput = "\(bootstrapOutput)\n正在初始化：刷新自检..."
                bootstrapPaths = defaultBootstrapPaths()
            }
            selfCheck = try await api.get("api/self-check", query: ["force": "1"])
            bootstrapOutput = "\(bootstrapOutput)\n初始化完成。"
        } catch {
            bootstrapOutput = "初始化失败：\n\(shortError(error.localizedDescription))"
        }
        isBootstrapping = false
        endLoading(ticket)
    }

    func hideOnboardingPermanently() {
        UserDefaults.standard.set(true, forKey: Self.onboardingHiddenKey)
        onboardingHidden = true
        if section == .onboarding {
            section = .overview
            Task { await refresh() }
        }
    }

    func toggleDarkMode() {
        darkMode.toggle()
        UserDefaults.standard.set(darkMode, forKey: Self.darkModeKey)
    }

    private func mutate(_ work: () async throws -> Void) async {
        let ticket = beginLoading()
        error = nil
        do {
            try await work()
            await refresh()
            endLoading(ticket)
        } catch {
            self.error = error.localizedDescription
            endLoading(ticket)
        }
    }

    private func mutateNoRefresh(_ work: () async throws -> Void) async {
        let ticket = beginLoading()
        error = nil
        do {
            try await work()
        } catch {
            self.error = error.localizedDescription
        }
        endLoading(ticket)
    }

    private func beginLoading() -> Int {
        loadingTicket += 1
        let ticket = loadingTicket
        isLoading = true
        showLoadingIndicator = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(220))
            if isLoading && loadingTicket == ticket {
                withAnimation(.easeOut(duration: 0.16)) {
                    showLoadingIndicator = true
                }
            }
        }
        return ticket
    }

    private func endLoading(_ ticket: Int) {
        guard loadingTicket == ticket else { return }
        isLoading = false
        withAnimation(.easeOut(duration: 0.16)) {
            showLoadingIndicator = false
        }
    }

    private func showOnboarding(_ message: String) {
        onboardingHidden = false
        section = .onboarding
        error = nil
        if bootstrapOutput.isEmpty { bootstrapOutput = message }
    }

    private func shouldGuideInitialization(_ error: Error) -> Bool {
        if api.token.isEmpty { return true }
        if let urlError = error as? URLError {
            return [.cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .timedOut].contains(urlError.code)
        }
        if let apiError = error as? APIError, apiError.message == "unauthorized" {
            return true
        }
        return false
    }

    private func installBundledRuntime() async throws -> String {
        guard
            let script = Bundle.main.resourceURL?.appendingPathComponent("miu-kb/bin/install-on-mac.mjs"),
            FileManager.default.fileExists(atPath: script.path)
        else {
            throw APIError(message: "当前 App 未内置 miu-kb 安装资源，请重新打包。")
        }
        guard let node = findNodeExecutable() else {
            throw APIError(message: "未找到支持的 Node.js 18-24；better-sqlite3 暂不支持 Node 25，请用 nvm 安装 Node 22 或 20 后重新打开 Miu KB。")
        }
        let sourceRoot = script.deletingLastPathComponent().deletingLastPathComponent().path
        bootstrapOutput = """
        正在初始化：准备执行 App 内置安装脚本，可能需要 1-2 分钟...
        Node：\(node)
        Node 版本：\(nodeVersion(node) ?? "未知")
        命令：\(node) \(script.path) --overwrite
        安装源：\(sourceRoot)
        目标程序：~/.codex/miu-kb
        目标数据：~/.config/miu-kb
        """
        return try await runProcess(node, arguments: [script.path, "--overwrite"])
    }

    private func findNodeExecutable() -> String? {
        var candidates = [
            ProcessInfo.processInfo.environment["MIU_KB_NODE_BIN"],
        ].compactMap { $0 }
        candidates.append(contentsOf: nvmNodeExecutables())
        candidates.append(contentsOf: [
            "/opt/homebrew/opt/node@22/bin/node",
            "/opt/homebrew/opt/node@20/bin/node",
            "/usr/local/opt/node@22/bin/node",
            "/usr/local/opt/node@20/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ])
        var seen = Set<String>()
        return candidates.first { path in
            guard FileManager.default.isExecutableFile(atPath: path), !seen.contains(path) else { return false }
            seen.insert(path)
            guard let major = nodeMajor(path) else { return false }
            return major >= 18 && major <= 24
        }
    }

    private func nvmNodeExecutables() -> [String] {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".nvm/versions/node")
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
        return items
            .filter { $0.range(of: #"^v?\d+\.\d+\.\d+$"#, options: .regularExpression) != nil }
            .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            .map { root.appendingPathComponent($0).appendingPathComponent("bin/node").path }
    }

    private func nodeMajor(_ path: String) -> Int? {
        guard let version = nodeVersion(path) else { return nil }
        return Int(version.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").first ?? "")
    }

    private func nodeVersion(_ path: String) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["-v"]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func runProcess(_ executable: String, arguments: [String]) async throws -> String {
        try await Task.detached {
            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("miu-kb-install-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: outputURL.path, contents: nil)
            let output = try FileHandle(forWritingTo: outputURL)
            defer {
                try? output.close()
                try? FileManager.default.removeItem(at: outputURL)
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.environment = ProcessInfo.processInfo.environment.merging([
                "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "MIU_KB_NODE_BIN": executable,
            ]) { current, _ in current }
            process.standardOutput = output
            process.standardError = output
            try process.run()
            process.waitUntilExit()
            let data = try Data(contentsOf: outputURL)
            let text = String(data: data, encoding: .utf8) ?? ""
            if process.terminationStatus != 0 {
                throw APIError(message: text.isEmpty ? "初始化失败，退出码 \(process.terminationStatus)" : text)
            }
            return text
        }.value
    }

    private func waitForServer() async -> Bool {
        let url = URL(string: "http://127.0.0.1:17322/health")!
        for _ in 0..<30 {
            if let (_, response) = try? await URLSession.shared.data(from: url),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                return true
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return false
    }

    private func defaultBootstrapPaths() -> [String: String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "app": "\(home)/.codex/miu-kb",
            "data": "\(home)/.config/miu-kb",
            "launchAgent": "\(home)/Library/LaunchAgents/com.miu.kb.plist",
        ]
    }

    private func shortError(_ text: String) -> String {
        String(text.prefix(1600))
    }
}

@main
struct MiuKbMacApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Miu KB") {
            ContentView()
                .environmentObject(model)
                .preferredColorScheme(model.darkMode ? .dark : .light)
                .frame(minWidth: 1120, minHeight: 720)
                .task { await model.launch() }
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Miu KB") {
                Button("刷新") { Task { await model.refresh() } }
                    .keyboardShortcut("r")
            }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationSplitView {
            List(model.visibleSections, selection: $model.section) { item in
                Text(item.rawValue).tag(item)
            }
            .navigationTitle("Miu KB")
            .onChange(of: model.section) { _, _ in Task { await model.refresh() } }
        } detail: {
            VStack(spacing: 0) {
                toolbar
                Divider()
                LoadingBar(isVisible: model.showLoadingIndicator)
                sectionBody
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .transaction { transaction in
                        transaction.disablesAnimations = true
                        transaction.animation = nil
                    }
            }
        }
        .alert("操作失败", isPresented: Binding(
            get: { model.error != nil },
            set: { if !$0 { model.error = nil } }
        )) {
            Button("知道了") { model.error = nil }
        } message: {
            Text(model.error ?? "")
        }
        .sheet(isPresented: Binding(
            get: { model.lifecycle != nil },
            set: { if !$0 { model.lifecycle = nil } }
        )) {
            if let lifecycle = model.lifecycle {
                LifecycleView(state: lifecycle)
                    .frame(minWidth: 620, minHeight: 420)
            }
        }
    }

    @ViewBuilder
    private var sectionBody: some View {
        switch model.section {
        case .onboarding: OnboardingView()
        case .overview: OverviewView()
        case .review: ReviewView()
        case .knowledge: KnowledgeView()
        case .trace: TraceView()
        case .ai: AiQueueView()
        case .selfCheck: SelfCheckView()
        case .settings: SettingsView()
        }
    }

    private var toolbar: some View {
        HStack {
            Text(model.section.rawValue)
                .font(.title2.weight(.semibold))
            Spacer()
            Button {
                model.toggleDarkMode()
            } label: {
                Image(systemName: model.darkMode ? "sun.max" : "moon")
            }
            .help(model.darkMode ? "切换到日间模式" : "切换到夜间模式")
            Button("刷新") { Task { await model.refresh() } }
        }
        .transaction { transaction in
            transaction.disablesAnimations = true
            transaction.animation = nil
        }
        .padding(16)
    }
}

struct LoadingBar: View {
    var isVisible: Bool

    var body: some View {
        Rectangle()
            .fill(Color.accentColor.opacity(0.55))
            .opacity(isVisible ? 1 : 0)
            .animation(.easeOut(duration: 0.16), value: isVisible)
        .frame(height: 2)
    }
}

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("首次使用向导")
                                .font(.title2.weight(.semibold))
                            Text("用于完成 Codex hook 注入、MCP 配置、AGENTS.md 持久记忆说明和本地脚本权限初始化。")
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Tag(model.selfCheck?.health ?? "未检查", tone: healthTone(model.selfCheck?.health))
                    }

                    HStack(spacing: 10) {
                        Button(model.isBootstrapping ? "初始化中..." : "初始化 / 修复 Hook 与配置") {
                            Task { await model.bootstrapFirstUse() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isBootstrapping)
                        Button("刷新自检") { Task { await model.runSelfCheck() } }
                            .disabled(model.isBootstrapping)
                        Button("测试模型调用") { Task { await model.runModelCheck() } }
                            .disabled(model.isBootstrapping)
                        Spacer()
                        Button("永久隐藏此页") { model.hideOnboardingPermanently() }
                            .disabled(model.isBootstrapping)
                    }
                }
                .card()

                HStack(spacing: 12) {
                    StatCard(title: "自检状态", value: model.selfCheck?.health ?? "未检查", hint: formatBeijingTime(model.selfCheck?.generatedAt))
                    StatCard(title: "检查项", value: "\(model.selfCheck?.checks.count ?? 0)", hint: "hook / mcp / cli")
                    StatCard(title: "初始化路径", value: "\(model.bootstrapPaths.count)", hint: model.bootstrapPaths.isEmpty ? "执行后显示" : "已返回")
                }

                if let modelCheck = model.modelCheck {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Tag(modelCheck.ok ? "模型可用" : "模型失败", tone: modelCheck.ok ? "approved" : "rejected")
                            Text(modelCheck.model)
                            Text(modelCheck.reasoningEffort ?? "")
                                .foregroundStyle(.secondary)
                        }
                        Text(modelCheck.detail ?? "")
                            .textSelection(.enabled)
                    }
                    .card()
                }

                if !model.bootstrapPaths.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("初始化写入位置")
                            .font(.headline)
                        ForEach(model.bootstrapPaths.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                            HStack(alignment: .firstTextBaseline) {
                                Text(pathLabel(key))
                                    .frame(width: 92, alignment: .leading)
                                    .foregroundStyle(.secondary)
                                Text(value)
                                    .textSelection(.enabled)
                            }
                            .font(.system(.callout, design: .monospaced))
                        }
                    }
                    .card()
                }

                if !model.bootstrapOutput.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            if model.isBootstrapping {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text(model.isBootstrapping ? "初始化进行中" : "初始化状态")
                                .font(.headline)
                        }
                        ScrollView {
                            Text(model.bootstrapOutput)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .font(.system(.callout, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 260)
                    }
                    .card()
                }

                LazyVStack(spacing: 12) {
                    ForEach(model.selfCheck?.checks ?? []) { check in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Tag(checkStatusLabel(check.status), tone: check.status == "pass" ? "approved" : check.status == "fail" ? "rejected" : "pending")
                                Text(check.title).font(.headline)
                            }
                            Text(check.detail ?? "")
                                .textSelection(.enabled)
                            if let hint = check.hint, !hint.isEmpty {
                                Text(hint)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                        .card()
                    }
                }
            }
            .padding(20)
        }
    }
}

struct OverviewView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                LazyVGrid(columns: [.init(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
                    StatCard(title: "状态", value: model.overview?.health ?? "未连接", hint: "本地服务")
                    StatCard(title: "待审核", value: "\(model.overview?.review.pending ?? 0)", hint: "候选记忆")
                    StatCard(title: "长期记忆", value: "\(model.overview?.memories.counts.active ?? 0)", hint: "可用")
                    StatCard(title: "AI 队列", value: "\(model.overview?.ai?.queue["all"] ?? 0)", hint: "待处理")
                    StatCard(title: "通过率", value: formatPercent(model.overview?.review.approvalRate ?? 0), hint: "已处理候选")
                    StatCard(title: "系统空间", value: model.overview?.storage.totalLabel ?? "-", hint: "miu-kb")
                }

                LazyVGrid(columns: [.init(.adaptive(minimum: 360), spacing: 12)], spacing: 12) {
                    TrendPanel(title: "最近 7 天候选生成", rows: model.overview?.last7Days ?? [])
                    BarPanel(title: "待审动作分布", rows: actionRows)
                    BarPanel(title: "待审类型", rows: pendingTypeRows)
                    BarPanel(title: "知识库类型", rows: memoryTypeRows)
                }

                RecentCandidatesPanel(items: model.overview?.recentCandidates ?? [])
            }
            .padding(20)
        }
    }

    private var actionRows: [MetricRow] {
        [
            MetricRow(label: "新建", value: model.overview?.review.actions?["create_new"] ?? 0),
            MetricRow(label: "更新", value: model.overview?.review.actions?["update_existing"] ?? 0),
            MetricRow(label: "合并", value: model.overview?.review.actions?["merge_pending"] ?? 0),
        ]
    }

    private var pendingTypeRows: [MetricRow] {
        ["rule", "decision", "fact", "note"].map {
            MetricRow(label: typeLabel($0), value: model.overview?.review.types?[$0] ?? 0)
        }
    }

    private var memoryTypeRows: [MetricRow] {
        ["rule", "decision", "fact", "note"].map {
            MetricRow(label: typeLabel($0), value: model.overview?.memories.counts.types[$0] ?? 0)
        }
    }
}

struct MetricRow: Identifiable {
    var label: String
    var value: Int
    var id: String { label }
}

struct TrendPanel: View {
    var title: String
    var rows: [OverviewDay]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            if rows.isEmpty {
                Text("暂无数据").foregroundStyle(.secondary)
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    ForEach(rows) { row in
                        VStack(spacing: 6) {
                            GeometryReader { proxy in
                                VStack {
                                    Spacer()
                                    RoundedRectangle(cornerRadius: 4)
                                        .fill(Color.accentColor.opacity(0.78))
                                        .frame(height: max(4, proxy.size.height * CGFloat(row.created) / CGFloat(maxCreated)))
                                }
                            }
                            .frame(height: 118)
                            Text(shortDayLabel(row.day))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(row.created)")
                                .font(.caption.weight(.medium))
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .card()
    }

    private var maxCreated: Int {
        max(1, rows.map(\.created).max() ?? 0)
    }
}

struct BarPanel: View {
    var title: String
    var rows: [MetricRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            ForEach(rows) { row in
                HStack(spacing: 10) {
                    Text(row.label)
                        .frame(width: 54, alignment: .leading)
                        .foregroundStyle(.secondary)
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.secondary.opacity(0.12))
                            Capsule()
                                .fill(Color.accentColor.opacity(0.76))
                                .frame(width: proxy.size.width * CGFloat(row.value) / CGFloat(maxValue))
                        }
                    }
                    .frame(height: 10)
                    Text("\(row.value)")
                        .font(.system(.callout, design: .monospaced))
                        .frame(width: 42, alignment: .trailing)
                }
            }
        }
        .card()
    }

    private var maxValue: Int {
        max(1, rows.map(\.value).max() ?? 0)
    }
}

struct RecentCandidatesPanel: View {
    var items: [OverviewCandidate]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("最近候选").font(.headline)
            if items.isEmpty {
                Text("暂无候选").foregroundStyle(.secondary)
            } else {
                ForEach(Array(items.prefix(6))) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Tag(statusLabel(item.status), tone: item.status)
                            Tag(actionLabel(item.memoryAction ?? "create_new"), tone: "neutral")
                            Text(formatBeijingTime(item.createdAt))
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        Text(item.content)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                    Divider()
                }
            }
        }
        .card()
    }
}

struct ReviewView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmingRejectedDelete = false
    @State private var confirmingDeletedPurge = false
    @State private var selectedDeletedIds: Set<String> = []
    private let filters = ["pending", "approved", "merged", "rejected", "archived", "deleted", "all"]

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Picker("状态", selection: $model.filter) {
                    ForEach(filters, id: \.self) { key in
                        Text("\(statusLabel(key)) \(countForFilter(key))").tag(key)
                    }
                }
                .pickerStyle(.segmented)
                .controlSize(.large)
                .onChange(of: model.filter) { _, _ in model.reviewPage = 1; Task { await model.refresh() } }

                HStack(spacing: 10) {
                    TextField("搜索候选记忆", text: $model.reviewQuery)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { model.reviewPage = 1; Task { await model.refresh() } }
                    Picker("每页", selection: $model.reviewPageSize) {
                        ForEach([10, 20, 50], id: \.self) { Text("每页 \($0) 条").tag($0) }
                    }
                    .frame(width: 136)
                    .onChange(of: model.reviewPageSize) { _, _ in model.reviewPage = 1; Task { await model.refresh() } }
                    Button {
                        model.reviewPage = 1
                        Task { await model.refresh() }
                    } label: {
                        Label("搜索", systemImage: "magnifyingglass")
                    }
                    if model.filter == "pending" {
                        Button {
                            Task { await model.enqueuePendingAiReview() }
                        } label: {
                            Label("AI 复核当前页", systemImage: "sparkles")
                        }
                        .disabled(currentPendingCount == 0)
                    }
                    if model.filter == "rejected" {
                        Button {
                            confirmingRejectedDelete = true
                        } label: {
                            Label("清空已拒绝", systemImage: "trash")
                        }
                        .tint(.red)
                        .disabled(countForFilter("rejected") == 0)
                    }
                    if model.filter == "deleted" {
                        Button(deletedSelectionIsFull ? "取消选择" : "全选当前页") {
                            if deletedSelectionIsFull {
                                selectedDeletedIds.removeAll()
                            } else {
                                selectedDeletedIds = Set(currentDeletedIds)
                            }
                        }
                        .disabled(currentDeletedIds.isEmpty)
                        Button {
                            let ids = selectedDeletedIdsOnPage
                            selectedDeletedIds.subtract(ids)
                            Task { await model.restoreDeletedCandidates(ids: Array(ids)) }
                        } label: {
                            Label("恢复选中", systemImage: "arrow.uturn.backward.circle")
                        }
                        .disabled(selectedDeletedIdsOnPage.isEmpty)
                        Button {
                            confirmingDeletedPurge = true
                        } label: {
                            Label("彻底删除选中", systemImage: "trash")
                        }
                        .tint(.red)
                        .disabled(selectedDeletedIdsOnPage.isEmpty)
                    }
                }
            }
            .padding(16)
            .background(Color(nsColor: .controlBackgroundColor))
            .overlay(alignment: .bottom) { Divider() }

            ScrollView {
                LazyVStack(spacing: 12) {
                    Pager(page: $model.reviewPage, pagination: model.reviewPagination) {
                        Task { await model.refresh() }
                    }
                    ForEach(model.candidates) { candidate in
                        if model.filter == "deleted" && candidate.status == "deleted" {
                            HStack(alignment: .top, spacing: 10) {
                                Toggle("", isOn: deletedSelectionBinding(candidate.id))
                                    .labelsHidden()
                                    .padding(.top, 18)
                                CandidateCard(candidate: candidate)
                            }
                        } else {
                            CandidateCard(candidate: candidate)
                        }
                    }
                    Pager(page: $model.reviewPage, pagination: model.reviewPagination) {
                        Task { await model.refresh() }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
        .confirmationDialog(
            "确认删除已拒绝候选？",
            isPresented: $confirmingRejectedDelete,
            titleVisibility: .visible
        ) {
            Button("删除 \(countForFilter("rejected")) 条已拒绝候选", role: .destructive) {
                Task { await model.deleteRejectedCandidates() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这些候选会移动到已删除状态，审核事件会保留。")
        }
        .confirmationDialog(
            "确认彻底删除选中候选？",
            isPresented: $confirmingDeletedPurge,
            titleVisibility: .visible
        ) {
            Button("彻底删除 \(selectedDeletedIdsOnPage.count) 条", role: .destructive) {
                let ids = selectedDeletedIdsOnPage
                selectedDeletedIds.subtract(ids)
                Task { await model.purgeDeletedCandidates(ids: Array(ids)) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这些记录会从审核台移除；关联的已删除长期记忆也会被清理。")
        }
    }

    private func countForFilter(_ key: String) -> Int {
        if key != "all" { return model.candidateCounts[key] ?? 0 }
        return filters.filter { $0 != "all" }.reduce(0) { $0 + (model.candidateCounts[$1] ?? 0) }
    }

    private var currentPendingCount: Int {
        model.candidates.filter { $0.status == "pending" }.count
    }

    private var currentDeletedIds: [String] {
        model.candidates.filter { $0.status == "deleted" }.map(\.id)
    }

    private var selectedDeletedIdsOnPage: Set<String> {
        selectedDeletedIds.intersection(Set(currentDeletedIds))
    }

    private var deletedSelectionIsFull: Bool {
        !currentDeletedIds.isEmpty && selectedDeletedIdsOnPage.count == currentDeletedIds.count
    }

    private func deletedSelectionBinding(_ id: String) -> Binding<Bool> {
        Binding {
            selectedDeletedIds.contains(id)
        } set: { selected in
            if selected {
                selectedDeletedIds.insert(id)
            } else {
                selectedDeletedIds.remove(id)
            }
        }
    }
}

struct KnowledgeView: View {
    @EnvironmentObject private var model: AppModel
    private let types = ["all", "rule", "decision", "fact", "note"]
    private let scopes = ["all", "global", "project", "branch"]

    var body: some View {
        VStack(spacing: 12) {
            Picker("类型", selection: $model.memoryType) {
                ForEach(types, id: \.self) { key in
                    Text(key == "all" ? "全部记忆 \(model.memoryCounts?.active ?? 0)" : "\(typeLabel(key)) \(model.memoryCounts?.types[key] ?? 0)").tag(key)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .onChange(of: model.memoryType) { _, _ in model.memoryPage = 1; Task { await model.refresh() } }

            HStack {
                TextField("搜索知识库", text: $model.memoryQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.memoryPage = 1; Task { await model.refresh() } }
                Picker("范围", selection: $model.memoryScope) {
                    ForEach(scopes, id: \.self) { Text($0 == "all" ? "全部范围" : scopeLabel($0)).tag($0) }
                }
                Picker("状态", selection: $model.memoryStatus) {
                    Text("可用记忆").tag("active")
                    Text("已删除").tag("deleted")
                    Text("全部").tag("all")
                }
                Picker("每页", selection: $model.memoryPageSize) {
                    ForEach([20, 50, 100], id: \.self) { Text("每页 \($0) 条").tag($0) }
                }
                Button("搜索") { model.memoryPage = 1; Task { await model.refresh() } }
                Button("扫描分支生命周期") { Task { await model.runBranchLifecycle() } }
            }
            .padding(.horizontal, 20)
            .onChange(of: model.memoryScope) { _, _ in model.memoryPage = 1; Task { await model.refresh() } }
            .onChange(of: model.memoryStatus) { _, _ in model.memoryPage = 1; Task { await model.refresh() } }
            .onChange(of: model.memoryPageSize) { _, _ in model.memoryPage = 1; Task { await model.refresh() } }

            ScrollView {
                LazyVStack(spacing: 12) {
                    HStack(spacing: 12) {
                        StatCard(title: "可用记忆", value: "\(model.memoryCounts?.active ?? 0)", hint: "active")
                        StatCard(title: "已删除", value: "\(model.memoryCounts?.deleted ?? 0)", hint: "deleted")
                        StatCard(title: "全局", value: "\(model.memoryCounts?.scopes["global"] ?? 0)", hint: "scope")
                        StatCard(title: "项目", value: "\(model.memoryCounts?.scopes["project"] ?? 0)", hint: "scope")
                    }
                    Pager(page: $model.memoryPage, pagination: model.memoryPagination) {
                        Task { await model.refresh() }
                    }
                ForEach(model.memories) { memory in
                    MemoryCard(memory: memory)
                }
                    Pager(page: $model.memoryPage, pagination: model.memoryPagination) {
                        Task { await model.refresh() }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
    }
}

struct TraceView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                Pager(page: $model.tracePage, pagination: model.tracePagination) {
                    Task { await model.refresh() }
                }
                ForEach(model.traces) { trace in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Tag(traceStatusLabel(trace.status), tone: traceTone(trace.status))
                            Text(formatBeijingTime(trace.createdAt)).foregroundStyle(.secondary)
                            Text("\(trace.approxTokens) token 估算").foregroundStyle(.secondary)
                            Spacer()
                            Text(trace.cwd ?? "").lineLimit(1).foregroundStyle(.secondary)
                        }
                        Text(trace.promptExcerpt ?? trace.query ?? "")
                            .font(.headline)
                            .textSelection(.enabled)
                        DisclosureGroup("规则 \(trace.rules.count)") {
                            if trace.rules.isEmpty {
                                EmptyHint("本轮没有命中规则类记忆；决策、事实和笔记会显示在“记忆”里。")
                            } else {
                                ForEach(trace.rules) { item in TraceItemRow(item: item) }
                            }
                        }
                        DisclosureGroup("记忆 \(trace.memories.count)") {
                            if trace.memories.isEmpty {
                                EmptyHint("本轮没有可注入的相关记忆。")
                            } else {
                                ForEach(trace.memories) { item in TraceItemRow(item: item) }
                            }
                        }
                        if let error = trace.error, !error.isEmpty {
                            Text(error).foregroundStyle(.red).textSelection(.enabled)
                        }
                    }
                    .card()
                }
                Pager(page: $model.tracePage, pagination: model.tracePagination) {
                    Task { await model.refresh() }
                }
            }
            .padding(20)
        }
    }
}

struct TraceItemRow: View {
    let item: TraceItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.id).font(.caption.weight(.medium))
                if let type = item.type { Text(typeLabel(type)).foregroundStyle(.secondary) }
                if let rank = item.rank { Text(String(format: "分数 %.4f", rank)).foregroundStyle(.secondary) }
            }
            if let reason = item.reason { Text(reason).font(.caption).foregroundStyle(.secondary) }
            Text(item.content).textSelection(.enabled)
        }
        .padding(.vertical, 6)
    }
}

struct AiQueueView: View {
    @EnvironmentObject private var model: AppModel
    private let statuses = ["all", "active", "processed", "error"]

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Picker("状态", selection: $model.aiStatus) {
                    ForEach(statuses, id: \.self) { key in
                        Text("\(queueStatusLabel(key)) \(model.aiCounts[key] ?? 0)").tag(key)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: model.aiStatus) { _, _ in model.aiPage = 1; Task { await model.refresh() } }
                Button("处理队列") { Task { await model.runWorker() } }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)

            HStack {
                TextField("搜索队列", text: $model.aiQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.aiPage = 1; Task { await model.refresh() } }
                Picker("每页", selection: $model.aiPageSize) {
                    ForEach([20, 50, 100], id: \.self) { Text("每页 \($0) 条").tag($0) }
                }
                Button("搜索") { model.aiPage = 1; Task { await model.refresh() } }
            }
            .padding(.horizontal, 20)
            .onChange(of: model.aiPageSize) { _, _ in model.aiPage = 1; Task { await model.refresh() } }

            ScrollView {
                LazyVStack(spacing: 12) {
                    Pager(page: $model.aiPage, pagination: model.aiPagination) {
                        Task { await model.refresh() }
                    }
                    ForEach(model.queueTurns) { turn in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Tag(queueStatusLabel(turn.status), tone: turn.status == "error" ? "rejected" : "neutral")
                                if turn.taskType == "review_pending_candidates" {
                                    Tag("AI 复核批次", tone: "pending")
                                }
                                Text(formatBeijingTime(turn.createdAt)).foregroundStyle(.secondary)
                                Spacer()
                                Text(turn.id).foregroundStyle(.secondary)
                            }
                            if let processedAt = turn.processedAt, turn.taskType == "review_pending_candidates" {
                                Text("完成时间 \(formatBeijingTime(processedAt))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(turn.cwd ?? "").textSelection(.enabled)
                            if turn.candidateCount > 0 {
                                HStack {
                                    StatMini("候选", turn.candidateCount)
                                    StatMini("待审", turn.pendingCandidateCount)
                                    StatMini("写入", turn.approvedCandidateCount)
                                    StatMini("拒绝", turn.rejectedCandidateCount)
                                }
                            } else if (turn.reviewCandidateCount ?? 0) > 0 {
                                HStack {
                                    StatMini("复核", turn.reviewCandidateCount ?? 0)
                                    StatMini("写入", turn.reviewCandidates.filter { $0.status == "approved" }.count)
                                    StatMini("拒绝", turn.reviewCandidates.filter { $0.status == "rejected" }.count)
                                    StatMini("保留", turn.reviewCandidates.filter { $0.status == "pending" }.count)
                                }
                                DisclosureGroup("审核明细 \(turn.reviewCandidates.count)") {
                                    LazyVStack(alignment: .leading, spacing: 8) {
                                        ForEach(turn.reviewCandidates) { item in
                                            QueueReviewCandidateRow(item: item)
                                        }
                                    }
                                    .padding(.top, 6)
                                }
                            } else {
                                Text(queueTurnHint(turn))
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                            if let error = turn.error, !error.isEmpty {
                                DisclosureGroup("错误") {
                                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                                }
                            }
                        }
                        .card()
                    }
                    Pager(page: $model.aiPage, pagination: model.aiPagination) {
                        Task { await model.refresh() }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
    }

    private func queueTurnHint(_ turn: QueueTurn) -> String {
        switch turn.status {
        case "queued": return "等待 AI 提炼，完成后进入审核台。"
        case "processing": return "AI 正在提炼候选记忆。"
        case "error": return "处理失败，展开错误查看原因。"
        default: return queueStatusLabel(turn.status)
        }
    }
}

struct QueueReviewCandidateRow: View {
    let item: QueueReviewCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Tag(reviewActionLabel(item.aiAction ?? item.status), tone: reviewActionTone(item.aiAction ?? item.status))
                if let type = item.type { Tag(typeLabel(type), tone: "neutral") }
                if let scope = item.scope { Tag(scopeLabel(scope), tone: "neutral") }
                Text(item.id).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if let confidence = item.aiConfidence {
                    Text("置信度 \(Int((confidence * 100).rounded()))%")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let content = item.content, !content.isEmpty {
                Text(content)
                    .font(.callout)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
            if let reason = item.aiReason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.25))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct SelfCheckView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                HStack {
                    StatCard(title: "整体状态", value: model.selfCheck?.health ?? "未检查", hint: formatBeijingTime(model.selfCheck?.generatedAt))
                    Button("快速自检") { Task { await model.runSelfCheck() } }
                    Button("测试模型调用") { Task { await model.runModelCheck() } }
                }
                if let modelCheck = model.modelCheck {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Tag(modelCheck.ok ? "可用" : "失败", tone: modelCheck.ok ? "approved" : "rejected")
                            Text(modelCheck.model)
                            Text(modelCheck.reasoningEffort ?? "")
                        }
                        Text(modelCheck.detail ?? "")
                    }
                    .card()
                }
                ForEach(model.selfCheck?.checks ?? []) { check in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Tag(checkStatusLabel(check.status), tone: check.status == "pass" ? "approved" : check.status == "fail" ? "rejected" : "pending")
                            Text(check.title).font(.headline)
                        }
                        Text(check.detail ?? "").textSelection(.enabled)
                        if let hint = check.hint, !hint.isEmpty {
                            Text(hint).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .card()
                }
                ForEach(model.selfCheck?.logs ?? []) { log in
                    SelfCheckLogCard(log: log)
                }
            }
            .padding(20)
        }
    }
}

struct SelfCheckLogCard: View {
    var log: LogItem

    private var tail: String {
        (log.tail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var emptyText: String {
        if !log.exists { return "日志文件尚未创建" }
        if log.key == "hook" { return "暂无 Codex Stop hook 入队日志；AI 队列处理记录看 AI worker 日志" }
        if log.key == "worker" { return "暂无 AI worker 处理记录；点击 AI 复核或处理队列后会写入" }
        return "暂无日志内容"
    }

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                Text(log.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if tail.isEmpty {
                    Text(emptyText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(tail)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
        } label: {
            HStack {
                Text(log.label)
                    .font(.headline)
                Spacer()
                Tag(tail.isEmpty ? "空" : "有内容", tone: tail.isEmpty ? "neutral" : "approved")
            }
        }
        .card()
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var modelName = ""
    @State private var reasoningEffort = "low"
    @State private var maxCandidates = "3"
    @State private var duplicateThreshold = "0.72"
    @State private var topicDuplicateThreshold = "0.62"
    @State private var relatedLimit = "5"
    @State private var relatedMinScore = "0.16"
    @State private var relatedItemChars = "320"
    @State private var relatedTotalChars = "2400"
    @State private var timeoutSeconds = "180"
    @State private var prompt = ""
    @State private var reviewPrompt = ""
    @State private var pendingAction: SettingsAction?
    @State private var notice: SettingsNotice?

    private struct SettingsNotice: Identifiable {
        let id = UUID()
        var title: String
        var message: String
    }

    private enum SettingsAction: String, Identifiable {
        case clearHooks
        case clearMemories
        case uninstall

        var id: String { rawValue }
        var title: String {
            switch self {
            case .clearHooks: return "清除 Codex 集成？"
            case .clearMemories: return "清除所有长期记忆？"
            case .uninstall: return "卸载 Miu KB？"
            }
        }
        var message: String {
            switch self {
            case .clearHooks: return "会移除 miu-kb 的 Hook、MCP 和 AGENTS.md 注入；不会删除记忆数据库。"
            case .clearMemories: return "会清空本地长期记忆库 local.db；审核台候选和配置不会删除。"
            case .uninstall: return "会移除 Hook、MCP、后台服务、CLI、程序目录和本地数据；App 本体不会自删。"
            }
        }
        var confirmTitle: String {
            switch self {
            case .clearHooks: return "清除 Hook"
            case .clearMemories: return "清除记忆"
            case .uninstall: return "卸载"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SettingsSection(title: "Codex 集成", footer: "修改后建议重启 Codex App 或新开会话，让 MCP 与 Hook 配置重新加载。") {
                    SettingsActionRow(
                        icon: "link.badge.plus",
                        title: "注入 Hook 与 MCP",
                        subtitle: "写入 Codex Hook、MCP server 和 AGENTS.md 说明"
                    ) {
                        Task {
                            await model.injectCodexIntegration()
                            await MainActor.run {
                                notice = SettingsNotice(title: "设置完成", message: model.bootstrapOutput)
                            }
                        }
                    }
                    Divider()
                    SettingsActionRow(
                        icon: "xmark.circle",
                        title: "清除 Hook 与 MCP",
                        subtitle: "移除 miu-kb 在 Codex 配置里的注入",
                        role: .destructive
                    ) {
                        pendingAction = .clearHooks
                    }
                }

                SettingsSection(title: "数据", footer: "清除记忆只影响长期知识库，不会删除待审核候选、AI 队列和设置。") {
                    SettingsInfoRow(icon: "externaldrive", title: "长期记忆", value: "\(model.memoryCounts?.active ?? model.overview?.memories.counts.active ?? 0) 条")
                    Divider()
                    SettingsActionRow(
                        icon: "trash",
                        title: "清除所有记忆",
                        subtitle: "清空本地 local.db 中的长期记忆",
                        role: .destructive
                    ) {
                        pendingAction = .clearMemories
                    }
                }

                SettingsSection(title: "卸载", footer: "卸载后需要重新打开安装包才能再次初始化。") {
                    SettingsActionRow(
                        icon: "trash.slash",
                        title: "卸载 Miu KB",
                        subtitle: "移除本机服务、CLI、Codex 注入和本地数据",
                        role: .destructive
                    ) {
                        pendingAction = .uninstall
                    }
                }

                SettingsSection(title: "AI", footer: model.aiSettings?.path ?? "") {
                    SettingsGrid {
                        VStack(alignment: .leading) {
                            Text("模型").font(.caption).foregroundStyle(.secondary)
                            Picker("模型", selection: $modelName) {
                                ForEach(model.aiSettings?.modelOptions ?? [modelName], id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden()
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        VStack(alignment: .leading) {
                            Text("推理强度").font(.caption).foregroundStyle(.secondary)
                            Picker("推理强度", selection: $reasoningEffort) {
                                ForEach(["off", "low", "medium", "high"], id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden()
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        SettingField("每轮候选", text: $maxCandidates)
                        SettingField("重复阈值", text: $duplicateThreshold)
                        SettingField("主题重复阈值", text: $topicDuplicateThreshold)
                        SettingField("相似上下文条数", text: $relatedLimit)
                        SettingField("相似分数下限", text: $relatedMinScore)
                        SettingField("单条上下文长度", text: $relatedItemChars)
                        SettingField("上下文总长度", text: $relatedTotalChars)
                        SettingField("LLM 超时秒数", text: $timeoutSeconds)
                    }
                    Divider().padding(.vertical, 4)
                    HStack {
                        Spacer()
                        Button("保存设置") { Task { await model.saveSettings(currentSettings) } }
                            .buttonStyle(.borderedProminent)
                        Button("恢复默认设置") { Task { await model.resetSettings() } }
                    }
                }

                SettingsSection(title: "提示词") {
                    DisclosureGroup("AI 异步提炼提示词") {
                        TextEditor(text: $prompt)
                            .font(.system(.body, design: .monospaced))
                            .frame(minHeight: 280)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .background(.quaternary.opacity(0.45))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        HStack {
                            Button("保存提示词") { Task { await model.savePrompt(prompt) } }
                                .buttonStyle(.borderedProminent)
                            Button("恢复默认") { Task { await model.resetPrompt() } }
                        }
                        Text(model.promptState?.path ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                    Divider()
                    DisclosureGroup {
                        TextEditor(text: $reviewPrompt)
                            .font(.system(.body, design: .monospaced))
                            .frame(minHeight: 260)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .background(.quaternary.opacity(0.45))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        HStack {
                            Button("保存复核提示词") { Task { await model.saveReviewPrompt(reviewPrompt) } }
                                .buttonStyle(.borderedProminent)
                            Button("恢复默认") { Task { await model.resetReviewPrompt() } }
                        }
                        Text(model.reviewPromptState?.path ?? "").font(.caption).foregroundStyle(.secondary)
                    } label: {
                        HStack {
                            Text("AI 复核当前页提示词")
                            Spacer()
                            Tag(model.reviewPromptState?.usingDefault == true ? "默认" : "自定义", tone: "neutral")
                            if let updatedAt = model.reviewPromptState?.updatedAt {
                                Text(formatBeijingTime(updatedAt)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
        .alert(item: $pendingAction) { action in
            Alert(
                title: Text(action.title),
                message: Text(action.message),
                primaryButton: .destructive(Text(action.confirmTitle)) {
                    Task { await perform(action) }
                },
                secondaryButton: .cancel(Text("取消"))
            )
        }
        .alert(item: $notice) { notice in
            Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text("知道了"))
            )
        }
        .onAppear(perform: sync)
        .onChange(of: model.aiSettings?.settings.model) { _, _ in sync() }
        .onChange(of: model.promptState?.prompt) { _, _ in sync() }
        .onChange(of: model.reviewPromptState?.prompt) { _, _ in sync() }
    }

    private func perform(_ action: SettingsAction) async {
        let title: String
        switch action {
        case .clearHooks:
            await model.clearCodexIntegration()
            title = "清除完成"
        case .clearMemories:
            await model.clearStoredMemories()
            title = "清除完成"
        case .uninstall:
            await model.uninstallMiuKb()
            title = "卸载已开始"
        }
        await MainActor.run {
            notice = SettingsNotice(title: title, message: model.bootstrapOutput)
        }
    }

    private var currentSettings: AiSettings {
        AiSettings(
            model: modelName.isEmpty ? "gpt-5.5" : modelName,
            reasoningEffort: reasoningEffort,
            maxCandidatesPerTurn: Int(maxCandidates) ?? 3,
            duplicateThreshold: Double(duplicateThreshold) ?? 0.72,
            topicDuplicateThreshold: Double(topicDuplicateThreshold) ?? 0.62,
            relatedContextLimit: Int(relatedLimit) ?? 5,
            relatedContextMinScore: Double(relatedMinScore) ?? 0.16,
            relatedContextItemChars: Int(relatedItemChars) ?? 320,
            relatedContextTotalChars: Int(relatedTotalChars) ?? 2400,
            llmTimeoutMs: (Int(timeoutSeconds) ?? 180) * 1000
        )
    }

    private func sync() {
        guard let settings = model.aiSettings?.settings else { return }
        modelName = settings.model
        reasoningEffort = settings.reasoningEffort
        maxCandidates = "\(settings.maxCandidatesPerTurn)"
        duplicateThreshold = "\(settings.duplicateThreshold)"
        topicDuplicateThreshold = "\(settings.topicDuplicateThreshold)"
        relatedLimit = "\(settings.relatedContextLimit)"
        relatedMinScore = "\(settings.relatedContextMinScore)"
        relatedItemChars = "\(settings.relatedContextItemChars)"
        relatedTotalChars = "\(settings.relatedContextTotalChars)"
        timeoutSeconds = "\(settings.llmTimeoutMs / 1000)"
        prompt = model.promptState?.prompt ?? prompt
        reviewPrompt = model.reviewPromptState?.prompt ?? reviewPrompt
    }
}

struct SettingsSection<Content: View>: View {
    var title: String
    var footer: String?
    @ViewBuilder var content: Content

    init(title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
            VStack(spacing: 0) {
                content
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
            if let footer, !footer.isEmpty {
                Text(footer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
            }
        }
    }
}

struct SettingsActionRow: View {
    var icon: String
    var title: String
    var subtitle: String
    var role: ButtonRole?
    var action: () -> Void

    init(icon: String, title: String, subtitle: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.role = role
        self.action = action
    }

    var body: some View {
        Button(role: role, action: action) {
            SettingsRowBody(icon: icon, title: title, subtitle: subtitle, value: nil)
        }
        .buttonStyle(.plain)
    }
}

struct SettingsInfoRow: View {
    var icon: String
    var title: String
    var value: String

    var body: some View {
        SettingsRowBody(icon: icon, title: title, subtitle: nil, value: value)
    }
}

struct SettingsRowBody: View {
    var icon: String
    var title: String
    var subtitle: String?
    var value: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 28, height: 28)
                .background(Color.accentColor.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let value {
                Text(value)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 8)
    }
}

struct CandidateCard: View {
    @EnvironmentObject private var model: AppModel
    let candidate: Candidate
    @State private var content: String
    @State private var type: String
    @State private var scope: String
    @State private var tags: String
    @State private var category: String

    init(candidate: Candidate) {
        self.candidate = candidate
        _content = State(initialValue: candidate.content)
        _type = State(initialValue: candidate.type)
        _scope = State(initialValue: candidate.scope)
        _tags = State(initialValue: candidate.tags.joined(separator: ", "))
        _category = State(initialValue: candidate.category ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Tag(statusLabel(candidate.status), tone: candidate.status)
                Tag(actionLabel(candidate.memoryAction), tone: "neutral")
                Text(formatBeijingTime(candidate.createdAt))
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Text(candidate.projectPath ?? candidate.cwd ?? "")
                    .font(.callout)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }

            TextEditor(text: $content)
                .font(.system(size: 15, weight: .regular, design: .rounded))
                .lineSpacing(3)
                .frame(minHeight: 84)
                .scrollContentBackground(.hidden)
                .padding(10)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.12)))

            if let message = candidate.targetResolutionMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            VStack(spacing: 12) {
                HStack(alignment: .bottom, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        FieldCaption("类型")
                        Picker("", selection: $type) {
                            ForEach(["rule", "decision", "fact", "note"], id: \.self) { Text(typeLabel($0)).tag($0) }
                        }
                        .labelsHidden()
                        .frame(width: 120)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        FieldCaption("范围")
                        Picker("", selection: $scope) {
                            ForEach(["project", "branch", "global"], id: \.self) { Text(scopeLabel($0)).tag($0) }
                        }
                        .labelsHidden()
                        .frame(width: 120)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        FieldCaption("标签")
                        TextField("用逗号分隔", text: $tags)
                            .textFieldStyle(.roundedBorder)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        FieldCaption("分组")
                        TextField("可选", text: $category)
                            .textFieldStyle(.roundedBorder)
                    }
                }

                HStack(spacing: 10) {
                    Text("确认无误后写入长期记忆")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        Task { await model.save(candidate, payload: payload) }
                    } label: {
                        Label("保存", systemImage: "tray.and.arrow.down")
                    }
                    .buttonStyle(.bordered)
                    if candidate.status == "pending" {
                        Button {
                            Task { await model.approve(candidate, payload: payload) }
                        } label: {
                            Label(approveTitle, systemImage: "checkmark.circle")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(candidate.targetResolutionMessage != nil)
                        Button {
                            Task { await model.reject(candidate) }
                        } label: {
                            Label("拒绝", systemImage: "xmark.circle")
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                    }
                    if candidate.status == "approved" {
                        Button {
                            Task { await model.deleteApprovedMemory(candidate) }
                        } label: {
                            Label("删除记忆", systemImage: "trash")
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                    }
                    if candidate.status == "deleted" {
                        Button {
                            Task { await model.restoreDeletedCandidate(candidate) }
                        } label: {
                            Label("恢复", systemImage: "arrow.uturn.backward.circle")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.12)))
        }
        .padding(16)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.16)))
        .shadow(color: Color.black.opacity(0.035), radius: 10, y: 3)
    }

    private var payload: CandidatePayload {
        CandidatePayload(
            content: content,
            type: type,
            scope: scope,
            tags: tags,
            category: category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : category
        )
    }

    private var approveTitle: String {
        if candidate.targetResolutionMessage != nil { return "目标不可合并" }
        if candidate.memoryAction == "merge_pending", candidate.targetCurrentStatus == "approved" { return "批准更新" }
        if candidate.memoryAction == "merge_pending" { return "合并候选" }
        if candidate.memoryAction == "update_existing" { return "批准更新" }
        return "批准写入"
    }
}

struct MemoryCard: View {
    @EnvironmentObject private var model: AppModel
    let memory: MemoryItem

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Tag(typeLabel(memory.type), tone: "neutral")
                Tag(scopeLabel(memory.displayScope ?? memory.scope), tone: "neutral")
                Spacer()
                Text(memory.id).foregroundStyle(.secondary)
            }
            Text(memory.content)
                .font(.system(size: 15))
                .textSelection(.enabled)
            HStack {
                if !memory.tags.isEmpty { Text("标签 " + memory.tags.joined(separator: ", ")) }
                if let category = memory.category { Text("分组 " + category) }
                if let projectId = memory.projectId { Text("项目 " + projectId) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack {
                Button("生命周期") { Task { await model.loadLifecycle(memory) } }
                Button("删除记忆") { Task { await model.deleteMemory(memory) } }
                    .tint(.red)
            }
        }
        .padding(14)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
    }
}

struct FieldCaption: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
    }
}

struct StatCard: View {
    var title: String
    var value: String
    var hint: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).foregroundStyle(.secondary)
            Text(value).font(.system(size: 28, weight: .semibold, design: .rounded))
            Text(hint).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
    }
}

struct StatMini: View {
    var label: String
    var value: Int
    init(_ label: String, _ value: Int) {
        self.label = label
        self.value = value
    }

    var body: some View {
        VStack(alignment: .leading) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text("\(value)").font(.headline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.quaternary.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct Pager: View {
    @Binding var page: Int
    var pagination: Pagination
    var onChange: () -> Void

    var body: some View {
        HStack {
            Text("第 \(pagination.page) / \(pagination.totalPages) 页， 共 \(pagination.total) 条")
                .foregroundStyle(.secondary)
            Spacer()
            Button("上一页") {
                page = max(1, page - 1)
                onChange()
            }
            .disabled(page <= 1)
            Button("下一页") {
                page = min(pagination.totalPages, page + 1)
                onChange()
            }
            .disabled(page >= pagination.totalPages)
        }
        .padding(.vertical, 4)
    }
}

struct SettingField: View {
    var title: String
    @Binding var text: String
    init(_ title: String, text: Binding<String>) {
        self.title = title
        _text = text
    }

    var body: some View {
        VStack(alignment: .leading) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, text: $text)
                .textFieldStyle(.roundedBorder)
        }
    }
}

struct SettingsGrid<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        LazyVGrid(columns: [.init(.adaptive(minimum: 220), spacing: 14)], spacing: 14) {
            content
        }
    }
}

struct LifecycleView: View {
    @EnvironmentObject private var model: AppModel
    let state: LifecycleState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("记忆生命周期").font(.title2.weight(.semibold))
                Spacer()
                Button {
                    model.lifecycle = nil
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.bordered)
                .help("关闭")
            }
            .padding(20)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if state.events.isEmpty {
                        EmptyHint("暂无审计事件。通常是旧数据、导入数据或 CLI 直接写入的记忆；当前记忆仍然可用。")
                    }
                ForEach(state.events) { event in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Tag(lifecycleLabel(event.action), tone: "neutral")
                            Text(formatBeijingTime(event.createdAt)).foregroundStyle(.secondary)
                        }
                        if let reason = event.reason { Text(reason).textSelection(.enabled) }
                    }
                    .card()
                }
                ForEach(state.candidates) { candidate in
                    HStack {
                        Tag("关联候选", tone: "neutral")
                        Text(candidate.id).textSelection(.enabled)
                        Text(statusLabel(candidate.status)).foregroundStyle(.secondary)
                        Text(scopeLabel(candidate.scope)).foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            Task { await model.openLifecycleCandidate(candidate.id) }
                        } label: {
                            Label("查看候选", systemImage: "arrow.right.circle")
                        }
                    }
                    .card()
                }
                    if state.candidates.isEmpty {
                        EmptyHint("没有找到关联候选。可能是这条记忆通过导入或 CLI 直接写入。")
                    }
                }
                .padding(20)
            }
        }
    }
}

struct EmptyHint: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.25))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct Tag: View {
    var text: String
    var tone: String
    init(_ text: String, tone: String) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.14))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private var color: Color {
        switch tone {
        case "pending": .orange
        case "approved": .green
        case "rejected", "deleted": .red
        case "merged": .blue
        default: .secondary
        }
    }
}

extension View {
    func card() -> some View {
        self
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
    }
}

func formatPercent(_ value: Double) -> String {
    "\(Int((value * 100).rounded()))%"
}

private let beijingTimeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
    formatter.dateFormat = "北京时间 yyyy-MM-dd HH:mm:ss"
    return formatter
}()

private let sqliteUtcTimeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return formatter
}()

func formatBeijingTime(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "" }
    if let date = sqliteUtcTimeFormatter.date(from: value) {
        return beijingTimeFormatter.string(from: date)
    }
    if let date = ISO8601DateFormatter().date(from: value) {
        return beijingTimeFormatter.string(from: date)
    }
    return value
}

func shortDayLabel(_ value: String) -> String {
    value.suffix(5).replacingOccurrences(of: "-", with: "/")
}

func statusLabel(_ value: String) -> String {
    [
        "pending": "待审核",
        "ai_reviewing": "AI 复核中",
        "approved": "已写入",
        "merged": "已合并",
        "rejected": "已拒绝",
        "archived": "已归档",
        "deleted": "已删除",
        "all": "全部"
    ][value] ?? value
}

func typeLabel(_ value: String) -> String {
    ["rule": "规则", "decision": "决策", "fact": "事实", "note": "笔记"][value] ?? value
}

func scopeLabel(_ value: String) -> String {
    ["project": "项目", "branch": "分支", "global": "全局"][value] ?? value
}

func actionLabel(_ value: String) -> String {
    [
        "create_new": "新建记忆",
        "update_existing": "更新已有",
        "merge_pending": "合并待审",
        "skip_duplicate": "重复跳过"
    ][value] ?? value
}

func queueStatusLabel(_ value: String) -> String {
    [
        "all": "全部批次",
        "active": "待处理",
        "queued": "排队中",
        "processing": "处理中",
        "processed": "已处理",
        "error": "错误"
    ][value] ?? value
}

func reviewActionLabel(_ value: String) -> String {
    [
        "approve": "批准",
        "reject": "拒绝",
        "keep": "保留",
        "approved": "已写入",
        "rejected": "已拒绝",
        "pending": "待人工",
        "missing": "已缺失"
    ][value] ?? value
}

func reviewActionTone(_ value: String) -> String {
    switch value {
    case "approve", "approved": return "approved"
    case "reject", "rejected", "missing": return "rejected"
    case "keep", "pending": return "pending"
    default: return "neutral"
    }
}

func traceStatusLabel(_ value: String) -> String {
    [
        "ok": "已注入",
        "empty": "无命中",
        "error": "错误"
    ][value] ?? value
}

func traceTone(_ value: String) -> String {
    switch value {
    case "ok": return "approved"
    case "error": return "rejected"
    default: return "neutral"
    }
}

func checkStatusLabel(_ value: String) -> String {
    ["pass": "通过", "warn": "提醒", "fail": "失败"][value] ?? value
}

func healthTone(_ value: String?) -> String {
    switch value {
    case "pass", "ok", "healthy", "正常": return "approved"
    case "fail", "error", "异常": return "rejected"
    default: return "pending"
    }
}

func pathLabel(_ value: String) -> String {
    [
        "hooks": "hooks",
        "codexConfig": "Codex 配置",
        "agents": "AGENTS",
        "app": "程序目录",
        "data": "数据目录"
    ][value] ?? value
}

func lifecycleLabel(_ value: String) -> String {
    [
        "memory_approved": "批准写入",
        "memory_updated": "更新记忆",
        "memory_deleted": "删除记忆",
        "memory_backfilled": "历史补录",
        "branch_promoted": "分支提升",
        "branch_archived": "分支归档"
    ][value] ?? value
}
