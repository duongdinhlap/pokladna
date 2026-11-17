# Pokladna – phần mềm tính tiền có EET 2.0 và ARES

Phần mềm tính tiền chạy trên trình duyệt, dùng được trên máy tính, tablet và điện thoại. Giao diện chuyển được giữa **tiếng Việt và tiếng Séc**. Hóa đơn luôn in bằng tiếng Séc theo luật.

## Phần mềm làm được gì

| Chức năng | Mô tả |
|---|---|
| 🛒 **Bán hàng** | Quét mã vạch là giá hiện ra ngay. Tìm hàng theo tên (gõ không dấu cũng được). Gõ `3*` rồi quét = bán 3 cái. Có nút hàng hay bán, hàng tự nhập giá, tiền mặt (tự tính tiền thừa, làm tròn 1 Kč) và thẻ |
| 🧾 **Hóa đơn** | In ra máy in nhiệt 80 mm / 58 mm hoặc A4. Tự chọn đúng loại theo luật: *zjednodušený daňový doklad* (≤ 10 000 Kč), *daňový doklad* (trên 10 000 Kč hoặc khi có khách là công ty), *opravný daňový doklad* (storno), *účtenka* (người không đóng DPH) |
| 🏢 **ARES** | Gõ IČO là tự điền tên, địa chỉ, DIČ của khách hoặc của cửa hàng mình |
| 📡 **EET 2.0** | Gửi từng hóa đơn lên Finanční správa (giao diện SOAP v4.1, có chữ ký số) và in mã POK. Mất mạng thì hóa đơn vẫn bán được, hệ thống tự gửi lại mỗi phút (luật cho phép trong 48 giờ). Có nút "Gửi lại EET" và danh sách "Lỗi EET" |
| ↩︎ **Hủy hóa đơn (storno)** | Tạo hóa đơn âm, gửi số tiền âm lên EET (đúng hướng dẫn của Finanční správa) và trả hàng lại vào kho |
| 📦 **Hàng hóa** | Danh sách hàng. Mỗi hàng có mã vạch, giá bán, **mức thuế DPH 21 % / 12 % / 0 %**, giá nhập, đơn vị (ks, kg…) và tồn kho. Hiện lãi gộp |
| 📥 **Nhập hàng** | Quét hàng vừa về, nhập số lượng, giá nhập và giá bán mới. Có lịch sử nhập |
| 📊 **Báo cáo** | Doanh thu theo ngày, tiền mặt / thẻ, tổng hợp DPH, hàng bán chạy, doanh thu theo nhân viên. In báo cáo cuối ngày (uzávěrka), xuất CSV cho kế toán |
| 👥 **Nhân viên** | Đăng nhập bằng mã PIN. **Thu ngân** chỉ được bán hàng và xem hóa đơn. **Quản lý** được làm tất cả: sửa giá, hủy hóa đơn, cài đặt |

## Máy quét mã vạch

Máy quét USB hay Bluetooth thông thường đều hoạt động như bàn phím: nó gõ dãy số rồi bấm Enter. Bạn chỉ cần cắm vào là dùng được, không phải cài gì thêm. Ở màn hình Bán hàng, khi quét, phần mềm luôn nhận mã kể cả lúc con trỏ đang ở chỗ khác.

* Nếu mã chưa có trong danh sách: **quản lý** thêm hàng mới ngay tại chỗ (mã đã được điền sẵn), **thu ngân** bán với giá tự nhập.
* Phím tắt: **F2** = tiền mặt, **F4** = thẻ, **Enter** = xác nhận, **Esc** = đóng, **F8** = tìm hàng.

## Cài đặt và chạy

Cần **Node.js 22.13** trở lên (https://nodejs.org).

```bash
npm install
npm start
```

Mở http://localhost:3000. Lần đầu mở, phần mềm yêu cầu tạo tài khoản quản lý.

Dữ liệu được lưu trong thư mục `data/` (file `pokladna.db`). **Hãy sao lưu thư mục này mỗi ngày.**

### Dùng online (từ nhiều máy hoặc từ điện thoại)

Thuê một máy chủ VPS rẻ (khoảng 100–150 Kč/tháng), rồi chạy bằng Docker:

```bash
docker build -t pokladna .
docker run -d --restart=always -p 3000:3000 -v pokladna-data:/data --name pokladna pokladna
```

Đặt **HTTPS** phía trước, ví dụ dùng Caddy. Caddy tự cấp chứng chỉ SSL miễn phí. File `Caddyfile`:

```
pokladna.ten-mien-cua-ban.cz {
    reverse_proxy localhost:3000
}
```

> ⚠️ Khi dùng online bắt buộc phải có HTTPS, vì mã PIN và chứng chỉ EET đi qua mạng.

## Cài đặt EET 2.0 (bắt buộc từ 1/1/2027)

1. Đăng nhập **DIS+** (portal MOJE daně) và đăng ký **evidenční jednotka** (cơ sở bán hàng). Ghi lại **mã ID** của cơ sở, ví dụ `11`.
2. Cũng trong DIS+, tạo **pokladní certifikát** (miễn phí). Bạn sẽ nhận được file `.p12` và mật khẩu.
3. Trong phần mềm, vào **Cài đặt → EET 2.0**:
   * tải file `.p12` lên và nhập mật khẩu,
   * điền mã cơ sở và mã máy tính tiền (tự đặt, ví dụ `POKLADNA-1`),
   * bấm **Kiểm tra kết nối EET**.
4. Chuyển môi trường sang **THẬT (production)**, tích **Bật EET** rồi bấm Lưu.

Ở môi trường **thử nghiệm (playground)**, mã POK trả về có đuôi `-ff`. Mã này **không có giá trị pháp lý** và trên hóa đơn sẽ in chữ "TESTOVACÍ".

Các điểm kỹ thuật chính, làm đúng theo tài liệu chính thức của Finanční správa (*Popis datového rozhraní v1.2a*, XSD v4.1):

* Địa chỉ gửi thật: `https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4`. Địa chỉ thử: `https://pg.trzbyeet.gov.cz/...`.
* Chữ ký WS-Security theo chuẩn RSA-SHA256 và Exclusive C14N, có gắn chứng chỉ trong BinarySecurityToken.
* Mỗi lần gửi dùng một UUID mới. Từ lần gửi lại thứ hai trở đi đặt `prvni_zaslani=false`, còn phần Data giữ nguyên.
* Thời gian chờ phản hồi tối thiểu là 2 giây (§ luật EET).
* Storno được gửi thành một tržba mới có số tiền âm và số thứ tự riêng.

## Thông tin trên hóa đơn (theo luật CZ)

Phần mềm tự in các thông tin sau: tên người bán, địa chỉ trụ sở và địa chỉ cơ sở, IČO, DIČ (hoặc dòng "Nejsem plátce DPH"), số hóa đơn, ngày giờ lập, DUZP, tên và số lượng hàng, đơn giá, mức thuế, bảng tổng hợp DPH (chưa thuế / thuế / tổng), tổng tiền, hình thức thanh toán và thu ngân. Với hóa đơn đầy đủ còn in thêm thông tin người mua và đơn giá chưa thuế. Phần EET gồm mã cơ sở, mã máy, số thứ tự, thời gian và mã POK.

Hãy điền đầy đủ ở **Cài đặt → Thông tin cửa hàng**. Bấm "Lấy từ ARES" để tự điền, sau đó ghi thêm thông tin đăng ký, ví dụ *Zapsán v živnostenském rejstříku*.

## Cấu trúc mã nguồn

```
src/eet.js       – client EET 2.0 (ký số, gửi, đọc kết quả)
src/receipts.js  – tạo hóa đơn, storno, gửi lại EET
src/server.js    – API + ARES + phân quyền
src/db.js        – cơ sở dữ liệu SQLite
public/          – giao diện (app.js, receipt.js = mẫu in, i18n.js = tiếng Việt/Séc)
test/            – kiểm thử (npm test)
```
