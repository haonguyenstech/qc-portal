# Chat page — danh sách việc cần polish UI

Ghi nhận từ một lượt soi thật trang `/chat` ở 1512×900 (light theme, project `pre-healthcare`,
4 hội thoại đã lưu), sau khi đã bỏ viền ngoài + padding của khung page. Xếp theo mức "đổi cảm
giác nhiều nhất trên mỗi dòng code".

Các file liên quan: `web/src/pages/ChatPage.tsx`, `web/src/App.tsx`,
`web/src/components/NotificationBell.tsx`.

---

## 1. Hai sidebar cạnh nhau ăn 528px chrome trước khi tới nội dung

Nav app (240px) + rail chat (288px) nằm sát nhau, nên transcript bắt đầu ở hơn một phần ba
màn hình 1512px — mà rail lại là phần chứa ít thông tin nhất.

**Làm:** cho rail collapse được bằng một nút toggle trong header chat, nhớ theo project (cùng
kiểu `qc.terminalTabs.<projectId>`). Lúc collapse = chỉ còn icon New Chat + search, hoặc ẩn
hẳn và thay bằng nút "Conversations".

---

## 2. Row trong rail là text trần  ✅ đã làm

`hot new / hi / hi / hi` đọc như một list debug: không hover surface, không active state,
không timestamp — và nút `…` chia sẻ chiều rộng với row nên mọi title bị truncate sớm 36px
dù không hover gì.

**Đã làm:**
- row 2 dòng — tên ở trên, `railTime(updatedAt)` bên dưới ("59m ago", tương đối trong vòng
  1 tuần rồi chuyển sang ngày); đang stream thì dòng đó thành chấm pulse + "Answering…";
- `rounded-xl px-3 py-2 hover:bg-muted`, row active `bg-muted` + vạch accent bên trái;
- `…` overlay lên row (`absolute`, row có `pe-10`) nên title dùng hết chiều rộng;
- star vẫn vẽ trên row khi đã set (giữ nguyên — search lọc mất group header thì row phải tự
  trả lời "sao nó đứng đầu?").
- ~~canh icon search về cùng cột text với các row~~ — xong ở mục 3.1.

---

## 3. Cột chat không có header  ✅ đã làm

Bell (`fixed right-6 top-5`) trôi thẳng trên transcript ngay khi padding của page bị bỏ, và
không có gì trên màn hình cho biết đang mở hội thoại nào, lượt này có quyền **ghi** vào repo
hay không, hay rename/export/delete ở đâu mà không phải quay về rail.

**Đã làm:** thanh `h-14` phía trên cột — tên hội thoại (hoặc "New chat"), chấm pulse
"Answering…" khi đang stream, pill `Read-only` / `Full access`, và Star / ⋯ (Rename,
Export .md, Delete). Padding phải chừa chỗ cho bell.

### 3.1 Đường kẻ ở chỗ giáp rail bị lệch  ✅ đã làm

Khối search cũ cao 60px (`Input h-11` + `py-2`) trong khi header là `h-14` = 56px → hai
`border-b` lệch 4px, thành một bậc thang ngay chỗ giáp nhau. Chữ cũng ở ba cột khác nhau:
search 40px, row 28px, group label 20px.

**Đã làm:** khối search thành `flex h-14 items-center`, icon search vào trong flow ở cột
`px-3` (thay vì `absolute left-0`), group label và dòng empty-state đổi `px-1` → `px-3`.

### 3.2 Bell canh vào đúng hàng header  ✅ đã làm

Bell là `fixed` toàn app, nên ở `/chat` nó nằm cao hơn hàng header. Nay chỉ riêng route này
dùng `right-4 top-2.5` (`(56 − 36) / 2 = 10px`), các trang khác giữ nguyên offset nổi.

---

## 4. Dải hint bọc composer trong một well xám nổi lên

`bg-muted` bao quanh một input trắng lặp lại đúng cái artefact "pill nổi" vừa sửa ở ô search
của rail.

**Làm:** gộp thành một card — hairline border, `rounded-2xl`, hint là dòng footer *bên trong*.
Hai lỗi cụ thể trong dải đó:
- **dangling bullet** — chuỗi hint kết thúc bằng `… + for web search •`;
- **đường dẫn tuyệt đối xuống dòng thứ hai** (`/Users/hao.nguyen/coding/…`). Nên là chip mono,
  `truncate max-w-[24ch]`, full path để trong `title`.

---

## 5. Composer nhảy chỗ giữa trạng thái empty và đã có hội thoại  ✅ đã làm

Empty: greeting + composer canh giữa viewport. Sau tin nhắn đầu: composer xuống đáy. Nên gửi
câu hỏi đầu tiên làm cả layout giật.

**Đã làm:** vùng scroll (`role="log"`) giờ **luôn mounted** trong cả hai trạng thái, greeting +
orb + quick chips nằm **bên trong** nó và được `flex-1` canh giữa — nên composer ghim ở đáy từ
frame đầu tiên, và lần gửi đầu chỉ đổi nội dung trong hộp đó. Đo trên page thật: `textarea` ở
`top = 761px` ở **cả** empty và khi đã mở hội thoại.

Kèm một hệ quả phải sửa: list 4 prompt của một category vốn `absolute` đè lên slot cao 36px của
hàng chip (để composer không bị đẩy) — nay nằm trong scroller nên **hàng thứ 4 bị cắt** bởi mép
scroller. Composer đã ghim rồi nên bỏ `absolute`, list chiếm chiều cao thật và greeting dịch lên
một chút.

---

## 6. Accent tím lệch khỏi design language của portal

Gradient "Assist You Today?" và cái orb pastel không thuộc System-Style UI (surface neutral,
hairline border, một accent xanh dùng dè).

**Làm:** heading về `text-foreground`, `text-3xl tracking-tight`; orb nhỏ còn ~64px hoặc thay
bằng mark solid của portal (`rounded-2xl bg-foreground text-background` + Sparkles) — đúng thứ
mọi icon badge khác trong app đang dùng.

---

## 7. Footer của rail trùng với sidebar app  ✅ đã làm

`Tickets / Knowledge / Run history / Terminal` đã có ở nav trái, cách đó chừng hai inch — mà
chúng lại là 4 row full-width có label, đặt **trên** cả New Chat, nên chỗ giá trị nhất của rail
(đáy, cạnh action chính) dùng để lặp lại nav, và New Chat phải cạnh tranh với 4 link trông
giống nó.

**Đã làm:** thu thành **một hàng icon** (`h-9 flex-1 rounded-xl`, tooltip mang label, giữ
`aria-label` cho screen reader) đặt **dưới** New Chat + Temporary chat, và cả block footer nay
có `border-t border-border/60` tách khỏi danh sách hội thoại. Shortcut vẫn còn, nhưng không còn
đọc ra như navigation.

---

## 8. Popover notification  ✅ đã làm

Danh sách bị **scroll ngang**: `ul` chỉ có `overflow-y-auto`, mà CSS tính `overflow-x` thành
`auto` theo — nên một token không ngắt được trong description (`https://vibe.saigontechnology.vn`,
notice nào của Auto Agent cũng có) đẩy min-content width vượt panel.

**Đã làm:** `overflow-x-hidden` + `break-words [overflow-wrap:anywhere]`; icon chip tint theo
kind, thời gian lên cạnh title, unread là vạch accent bên trái + pill "N new" (snapshot id
chưa đọc lúc mở panel, vì `markAllRead()` lúc mở làm tint mất ngay), row có `to` hiện `Open ›`
khi hover, empty state có icon chip + dòng phụ. Kèm sửa một bug thật: `markAllRead()` bị gọi
bên trong updater của `setState` → React báo *"Cannot update a component while rendering a
different component"*; nay side effect chạy trong thân handler.
