def mime_type name
  mime = case name
         when 'html'
           'text/html'
         when 'json'
           'application/json'
         end
  return mime + '; charset=utf-8'
end

def resp code, type, body
  print "HTTP/1.0 200 OK\r\n"
  print "Content-Type: #{mime_type(type)}\r\n"
  print "Connection: close\r\n"
  print "Content-Lenght: #{body.length.to_s}\r\n\r\n"
  print body
  exit 0
end
