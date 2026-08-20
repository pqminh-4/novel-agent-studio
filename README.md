# Novel Agent Studio

Ứng dụng Windows local-first để xây dựng series, trò chuyện với AI Đạo diễn, lập dàn ý và phối hợp tám vai trò AI trong quá trình viết tiểu thuyết dài.

## Khả năng chính

- Đạo diễn trò chuyện để hoàn thiện brief có cấu trúc; khi đạt 100%, ứng dụng tự tạo và lưu một phiên bản dàn ý mới.
- Tám vai trò AI tách quyền rõ ràng: Đạo diễn, Kiến trúc sư, Hoạch định cảnh, Nhà văn, Biên tập viên, Cố vấn chỉnh sửa, Thủ thư Canon và Giám đốc hình ảnh.
- Provider BYOK gồm OpenAI, Anthropic, Google Gemini và Ollama. Provider được chọn chỉ được giải mã trong Electron main process rồi chuyển thẳng đến Application Runtime, không trả khóa về renderer.
- Manuscript Studio dùng Tiptap, autosave có lịch sử phiên bản, SQLite WAL/FTS5 và migration bảo toàn dữ liệu.
- Quản lý nhiều series/sách/chương với tạo, sửa, chuyển sách đang mở và lưu trữ mềm; dữ liệu lịch sử không bị xóa vật lý.
- Outline Studio có lịch sử phiên bản, duyệt đề xuất và khôi phục theo kiểu tạo phiên bản mới có liên kết nguồn, không ghi đè bản cũ.
- Durable AI Workflow có ba preset Nhanh/Cân bằng/Chất lượng, routing provider/model theo vai trò, checkpoint sau từng vai, usage ledger và điều khiển tạm dừng, tiếp tục, hủy hoặc thử lại.
- Job Tray và Review Center hiển thị tiến độ, token, chi phí, artifact theo từng checkpoint và cổng duyệt so sánh bản hiện tại với bản AI đề xuất.
- Workflow demo đang chạy được đánh dấu gián đoạn khi ứng dụng đóng; live request đã submit được chuyển sang `billing_unknown` để người dùng kiểm tra chi phí trước khi tạo attempt mới. Artifact luôn là proposal và chỉ commit chương/canon trong một transaction sau khi người dùng duyệt.
- Story Memory hợp nhất canon và tóm tắt chương có provenance; Data Safety hỗ trợ restore, project archive, migration backup và SQLite Safe Mode; Outline Studio, Visual Studio, dark/light theme và export Markdown/DOCX/EPUB/PDF.
- Bản Windows dùng renderer sandbox, context isolation, CSP, custom protocol, utility process và Electron fuses.

## Phát triển

Yêu cầu Node.js 24.19.x và pnpm 11.17.x.

```powershell
pnpm install
pnpm dev
```

Ollama là tùy chọn. Khi chưa cài, ứng dụng vẫn chạy với chế độ demo hoặc các provider cloud BYOK.

Python 3 + Pillow chỉ cần khi muốn tạo lại `build/icon.ico`; icon đã sinh sẵn nên không phải điều kiện để build ứng dụng.

## Kiểm tra và đóng gói

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm package:dir
pnpm package
```

`pnpm package` tạo installer NSIS x64, blockmap, SBOM CycloneDX 1.6 và `SHA256SUMS.txt` trong thư mục `release`.

## Nguyên tắc dữ liệu

- Bản thảo, dàn ý, canon và lịch sử phiên bản được lưu cục bộ.
- Migration schema v3 thêm trạng thái lưu trữ mềm, dự án đang mở và metadata duyệt/khôi phục dàn ý mà không làm mất dữ liệu v2.
- Migration schema v4 thêm durable workflow, attempt/artifact/event ledger và thống kê token/chi phí; test hồi quy xác nhận nâng từ v3 mà vẫn giữ dữ liệu hiện hữu.
- Migration schema v5 thêm route cố định theo checkpoint, request ID, HTTP status, retry/backoff, billing state, cost provenance và usage theo attempt mà không xóa dữ liệu v4.
- Migration schema v6 thêm chapter summary theo document version, chỉ mục context FTS5 và ngân sách context theo checkpoint; quá trình backfill không sửa bản thảo hoặc lịch sử phiên bản hiện hữu.
- Migration schema v7 thêm nhật ký recovery. Trước mọi lần nâng schema cũ, ứng dụng tạo một SQLite snapshot toàn vẹn trong `data/recovery/migrations` rồi mới chạy migration.
- API key được bảo vệ bằng Windows DPAPI thông qua Electron `safeStorage`.
- Không đưa khóa bí mật vào bản export, log hoặc repository.
- Nếu provider đã chọn không phản hồi, Đạo diễn thông báo và quay về chế độ cục bộ để không làm gián đoạn dữ liệu.

## Cập nhật, log và chẩn đoán

`pnpm package` chỉ tạo installer cục bộ để kiểm tra. Auto-update dùng `electron-updater` với GitHub Releases của repository [`pqminh-4/novel-agent-studio`](https://github.com/pqminh-4/novel-agent-studio). Workflow GitHub Actions tại [`.github/workflows/release.yml`](.github/workflows/release.yml) sẽ kiểm tra tag, chạy quality gates và publish release khi có tag `vX.Y.Z` được push. Không cần đặt `CHANGE_ME` trong `package.json`; publisher đã trỏ tới repository này.

Quy trình phát hành:

```powershell
# Tăng version trong package.json và cập nhật lockfile nếu cần
pnpm install --lockfile-only
pnpm typecheck
pnpm test

# Commit thay đổi rồi tạo tag đúng package.json.version
git tag v0.1.6
git push origin master
git push origin v0.1.6
```

Có thể chạy lại release cho một tag đã tồn tại từ GitHub Actions bằng `workflow_dispatch`. Workflow dùng `GITHUB_TOKEN`, không cần lưu token trong repository. Mỗi release phải chứa installer NSIS x64, `latest.yml`, blockmap, SBOM CycloneDX và `SHA256SUMS.txt`; đây là các file cần thiết để `electron-updater` kiểm tra và tải cập nhật. Ứng dụng chỉ kiểm tra trong bản đã đóng gói, không tự tải hoặc tự cài, và sẽ hỏi lại trước khi khởi động lại khi còn workflow đang chạy.

- Log nằm ở `%APPDATA%/Novel Agent Studio/logs`, xoay vòng ở 2 MB và giữ tối đa 5 file. Log được che các chuỗi giống khoá bí mật và không được gửi tới bất kỳ máy chủ nào.
- `crashReporter` chỉ ghi dump cục bộ (`uploadToServer: false`).

## Trạng thái ký mã

Installer phát triển hiện chưa có chứng thư Authenticode. Windows SmartScreen có thể cảnh báo cho tới khi binary được ký bằng chứng thư tin cậy; không được coi log `signtool.exe` của electron-builder là bằng chứng đã ký.

## Sprint P0.3

Phiên bản `0.1.3` đưa OpenAI, Anthropic, Gemini và Ollama vào workflow BYOK thực tế. Mỗi vai trò có thể chọn provider, model và đơn giá riêng; route được khóa khi workflow bắt đầu để lịch sử có thể audit.

- Chế độ demo deterministic vẫn là mặc định để dùng và kiểm thử hoàn toàn offline.
- Mỗi provider có tối đa hai request đồng thời. HTTP `429` được retry có backoff và tôn trọng `Retry-After`.
- Timeout, mất kết nối hoặc lỗi máy chủ sau khi submit chuyển sang `billing_unknown`; ứng dụng không tự failover và không tự tạo request có thể bị tính phí hai lần.
- Usage token lấy từ phản hồi provider. Chi phí được ước tính từ usage thực khi người dùng nhập đủ đơn giá USD/1M token; nếu thiếu đơn giá, UI hiển thị `Chưa xác định`.
- Pause/cancel không commit output đến muộn. Nếu provider trả usage sau khi dừng, ledger vẫn ghi nhận chi phí nhưng artifact bị loại khỏi cổng duyệt.
- API key chỉ được giải mã trong main process và chuyển trực tiếp tới utility process; renderer chỉ nhận metadata kết nối đã che và route công khai.

## Sprint P0.4

Phiên bản `0.1.4` bổ sung bộ nhớ truyện dài local-first cho workflow nhiều vai trò. Mỗi chương có tóm tắt gắn với document version nguồn; canon và chapter memory được truy xuất theo FTS5 cùng độ liên quan trước khi khóa thành một context packet có provenance.

- Canon từ chương hiện tại hoặc tương lai bị loại khỏi packet để tránh rò diễn biến; UI đồng thời hiển thị cảnh báo continuity có nguồn.
- Bộ kiểm tra continuity theo dõi ràng buộc `mustAvoid`, motif `mustInclude` và các tuyến chưa khép từ ba chương gần nhất.
- Mỗi vai trò có ngân sách context từ `2.000` đến `1.000.000` token. Brief và outline được giới hạn riêng, workflow artifact không chiếm quá 50% packet, và tổng nguồn không vượt hard cap.
- Context packet được khóa tại checkpoint Thủ thư Canon. Các vai trò sau chỉ được rebudget packet này, không tự nạp thêm canon hoặc summary mới giữa workflow.
- `canon_delta` đề xuất chapter summary, sự kiện chính, tuyến chưa khép và canon fact. Tất cả chỉ được commit cùng bản thảo trong transaction sau khi duyệt; nhánh từ chối giữ nguyên manuscript, canon và chapter memory.
- Chế độ demo và toàn bộ test context/retrieval/migration/restart chạy deterministic, offline, không gọi provider hoặc phát sinh chi phí.

## Sprint P0.5

Phiên bản `0.1.5` hoàn thiện lớp Data Safety & Recovery để ứng dụng có thể tự bảo vệ dữ liệu trước migration và phục hồi workspace mà không ghi đè mù lên database hiện tại.

- SQLite backup được kiểm tra `integrity_check`, bảng bắt buộc và schema version trước khi xuất hiện trong luồng restore.
- Restore luôn tạo recovery point của workspace hiện tại, đóng Application Runtime bằng handshake, thay database qua staging file rồi khởi động lại ứng dụng. Backup lỗi bị chặn trước khi dữ liệu hiện tại bị thay đổi.
- Project archive `.novelproj` chứa `manifest.json` và `project.sqlite`; SHA-256, số series/sách/chương và schema phải khớp trước khi import. Archive không chứa API key hoặc vault.
- Khi database hỏng, thuộc schema mới hơn hoặc runtime không mở được, ứng dụng vào SQLite Safe Mode. Chế độ này không mở workflow và chỉ cho phép kiểm tra, restore backup hoặc import project archive.
- Recovery point trước migration/restore được liệt kê trong Data Safety. Các thao tác restore/import đều có xác nhận native mô tả rõ việc thay toàn bộ workspace.
- Test P0.5 chạy hoàn toàn offline, bao phủ corruption, checksum tampering, restore round-trip, rollback point, migration v6→v7 và bảo toàn manuscript.
