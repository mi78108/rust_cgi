#!/usr/bin/ruby
require "pathname"
require_relative '../_base'

Q.on(:GET) do |r|
    file_name = ['name','f','argv_1'].some do |v|
        Q.param v
    end
    file_name = [['f',->(v) { "./js#{v}.js" }],['name', -> (v){".js/#{v}"}],['argv_1',->(v) {"./js/#{v}.js"}]].some_proc do |v|
        Q.param v
    end
    if File::exist? file_name
        r.ok :js, File::read(file_name)
    end
    resp_404 "Script Not found File #{file_name}"
end